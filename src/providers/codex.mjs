// Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachRecord, humanText, readEnds } from '../jsonl.mjs';
import { addTally, contextWindow, emptyTally, fingerprint, tallyKey } from '../usage.mjs';

export const agent = 'codex';
export const command = 'codex';
export const glyph = '●';
export const color = 'green';
// `ccnav here`: codex removed --full-auto in 0.156, so the policy is named directly.
// This is the counterpart to Claude's --dangerously-skip-permissions: no approvals, no sandbox.
export const AUTO_ARGS = ['--dangerously-bypass-approvals-and-sandbox'];

export const HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SESSIONS_ROOT = path.join(HOME_DIR, 'sessions');
export const ARCHIVE_ROOT = path.join(HOME_DIR, 'ccnav-archive');
const INDEX_FILE = path.join(HOME_DIR, 'session_index.jsonl');

// session_index.jsonl names about half the sessions; read it once per listing.
function readIndex(onError = () => {}) {
  const map = new Map();
  let text;
  try { text = fs.readFileSync(INDEX_FILE, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') onError(INDEX_FILE, error);
    return map;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const { id, thread_name, updated_at } = JSON.parse(line);
      if (id) map.set(id, { title: thread_name || '', updatedAt: updated_at ? new Date(updated_at) : null });
    } catch { /* skip */ }
  }
  return map;
}

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(c => c.type === 'input_text' || c.type === 'text' || c.type === 'output_text')
  .map(c => c.text).join(' ');

export function readSession(file, index = readIndex()) {
  const { stat, head, tail } = readEnds(file);
  const meta = head.find(r => r.type === 'session_meta')?.payload;
  if (!meta?.cwd) return null;

  const firstPrompt = head
    .filter(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user')
    .map(r => humanText(textOf(r.payload.content)))
    .find(Boolean) || '';

  let lastText = '', lastTs, model = meta.model || '', tokens;
  for (const r of tail) {
    if (r.timestamp) lastTs = r.timestamp;
    const p = r.payload;
    if (r.type === 'turn_context' && p?.model) model = p.model;
    if (p?.type === 'token_count' && p.info?.last_token_usage) tokens = p.info;
    if (p?.type === 'task_complete' && p.last_agent_message) lastText = p.last_agent_message;
    else if (p?.type === 'agent_message' && p.message) lastText = p.message;
  }

  const id = meta.session_id || meta.id;
  const indexed = index.get(id);
  const stamps = [stat.mtime, lastTs && new Date(lastTs), indexed?.updatedAt].filter(Boolean);
  // Desktop and IDE sessions are stored here too; the CLI can still resume them.
  const origin = meta.source === 'cli' || /cli/i.test(meta.originator || '') ? 'cli' : 'desktop';

  return {
    agent, id, file,
    extraPaths: [],
    root: SESSIONS_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    cwd: meta.cwd,
    cwdExists: fs.existsSync(meta.cwd),
    branch: '',
    version: meta.cli_version || '',
    origin,
    // A session spawned by another session, like a Claude sidechain.
    subagent: !!(meta.source && typeof meta.source === 'object' && meta.source.subagent),
    parentId: meta.source?.subagent?.thread_spawn?.parent_thread_id || '',
    childFiles: [], // subagent rollouts, filled in by listSessions; their tokens bill to this session
    title: indexed?.title || '',
    firstPrompt,
    lastText: humanText(lastText),
    lastLabel: 'reply',
    created: new Date(meta.timestamp || head[0]?.timestamp || stat.birthtime),
    lastUsed: new Date(Math.max(...stamps.map(Number))),
    size: stat.size,
    fingerprint: fingerprint(stat),
    model,
    // input_tokens already includes the cached part, so this is the whole prompt of the last request.
    context: tokens ? {
      used: tokens.last_token_usage.input_tokens || 0,
      window: tokens.model_context_window || contextWindow(model),
    } : null,
    scratch: false,
  };
}

// sessions/YYYY/MM/DD/*.jsonl
export function listSessions({ onError = (file, error) => console.error(`ccnav: could not read Codex session at ${file}: ${error.message}`) } = {}) {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const index = readIndex(onError);
  const out = [];
  const subagents = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { onError(dir, error); return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const s = readSession(p, index);
          if (s) (s.subagent ? subagents : out).push(s);
        } catch (error) { onError(p, error); }
      }
    }
  };
  walk(SESSIONS_ROOT, 0);
  // Hand each subagent rollout to the listed session at the top of its spawn chain.
  const byId = new Map([...out, ...subagents].map(s => [s.id, s]));
  for (const sub of subagents) {
    let top = sub;
    for (let hops = 0; top?.subagent && hops < 32; hops++) top = byId.get(top.parentId);
    if (top && !top.subagent) top.childFiles.push(sub.file);
  }
  return out;
}

const usageFiles = s => [s.file, ...(s.childFiles || [])];

export function usageFingerprint(s) {
  return usageFiles(s).map(f => {
    try { return fingerprint(fs.statSync(f)); } catch { return '-'; }
  }).join(';');
}

// One token_usage_record per model response. Rollouts from before those records existed only have
// running totals in token_count events, so the last of those is used instead.
export async function scanUsage(s) {
  const byModel = {};
  for (const f of usageFiles(s)) {
    let model = 'unknown', total = null, totalModel = model, records = 0;
    const seen = new Set();
    await forEachRecord(f, ['"turn_context"', '"session_meta"', '"token_usage_record"', '"token_count"'], r => {
      const p = r.payload;
      if ((r.type === 'turn_context' || r.type === 'session_meta') && p?.model) model = p.model;
      else if (r.type === 'token_usage_record' && p?.usage) {
        if (p.response_id && seen.has(p.response_id)) return;
        seen.add(p.response_id);
        records++;
        addUsage(byModel, model, p.usage, 1);
      } else if (p?.type === 'token_count' && p.info?.total_token_usage) {
        total = p.info.total_token_usage;
        totalModel = model;
      }
    });
    if (!records && total) addUsage(byModel, totalModel, total, 0);
  }
  return byModel;
}

function addUsage(byModel, model, u, requests) {
  const cached = u.cached_input_tokens || 0;
  const written = u.cache_write_input_tokens || 0;
  const t = { ...emptyTally(),
    input: Math.max(0, (u.input_tokens || 0) - cached - written),
    cacheWrite5m: written,
    cacheRead: cached,
    output: u.output_tokens || 0, // reasoning tokens are included and billed as output
    requests,
  };
  addTally(byModel, tallyKey(model, { prompt: requests ? u.input_tokens || 0 : 0 }), t);
}

export function launchArgs(action, session, passthrough = []) {
  if (action === 'fork') return ['fork', session.id, ...passthrough];
  if (action === 'new') return [...passthrough];
  return ['resume', session.id, ...passthrough];
}
