// Claude Code sessions: ~/.claude/projects/<encoded-dir>/<session-id>.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachRecord, humanText, jsonlFilesUnder, readEnds } from '../jsonl.mjs';
import { addTally, contextWindow, dayOf, fingerprint, tallyKey } from '../usage.mjs';

export const agent = 'claude';
export const command = 'claude';
export const glyph = '◆';
export const color = 'cyan';
// `ccnav here`: a fresh session that never stops to ask for permission.
export const AUTO_ARGS = ['--dangerously-skip-permissions'];

export const HOME_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SESSIONS_ROOT = path.join(HOME_DIR, 'projects');
export const ARCHIVE_ROOT = path.join(HOME_DIR, 'ccnav-archive');

function promptText(r) {
  if (r.type !== 'user' || r.isMeta || r.isSidechain) return '';
  const c = r.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
  return humanText(text);
}

export function readSession(file) {
  const { stat, head, tail } = readEnds(file);
  const firstMsg = head.find(r => r.cwd && r.timestamp);
  const firstPrompt = head.map(promptText).find(Boolean);
  let title, lastPrompt, lastTs, bridge, lastCwd, branch, lastTurn;
  for (const r of tail) {
    if (r.type === 'assistant' && !r.isSidechain && r.message?.usage && r.message.model !== '<synthetic>') lastTurn = r.message;
    if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.timestamp) lastTs = r.timestamp;
    if (r.cwd) lastCwd = r.cwd;
    if (r.gitBranch) branch = r.gitBranch;
  }
  for (const r of head) if (r.type === 'bridge-session' && r.bridgeSessionId) bridge = r.bridgeSessionId;
  if (!title) for (const r of head) if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;

  const cwd = firstMsg?.cwd || lastCwd;
  if (!cwd) return null; // no conversation ever happened

  const id = path.basename(file, '.jsonl');
  const u = lastTurn?.usage;
  return {
    agent, id, file,
    // Subagent sidechains live in a folder named after the session; archive it alongside.
    extraPaths: [path.join(path.dirname(file), id)],
    root: SESSIONS_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    cwd,
    cwdExists: fs.existsSync(cwd),
    branch: (b => b === 'HEAD' ? '' : b)(branch || firstMsg?.gitBranch || ''),
    version: firstMsg?.version || '',
    origin: 'cli',
    title: title || '',
    firstPrompt: firstPrompt || '',
    lastText: lastPrompt || '',
    lastLabel: 'last',
    bridgeSessionId: bridge || '',
    created: new Date(firstMsg?.timestamp || stat.birthtime),
    lastUsed: lastTs ? new Date(Math.max(new Date(lastTs), stat.mtime)) : stat.mtime,
    size: stat.size,
    fingerprint: fingerprint(stat),
    model: lastTurn?.model || '',
    // What the last request sent, i.e. how full the context window is now.
    context: u ? {
      used: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      window: contextWindow(lastTurn.model),
    } : null,
    // Claude Desktop scratch folders: %APPDATA%\Claude\... on Windows, ~/Library/Application Support/Claude/... on macOS.
    scratch: /[\\/]Claude[\\/]scratch-workspaces[\\/]/i.test(cwd),
  };
}

// Top-level *.jsonl only: <sessionId>/ subdirectories hold subagent sidechains.
export function listSessions({ onError = (file, error) => console.error(`ccnav: could not read Claude session at ${file}: ${error.message}`) } = {}) {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out = [];
  for (const dir of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(SESSIONS_ROOT, dir.name);
    let files;
    try { files = fs.readdirSync(projectDir); }
    catch (error) { onError(projectDir, error); continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(projectDir, f);
      try {
        const s = readSession(file);
        if (s) out.push(s);
      } catch (error) { onError(file, error); }
    }
  }
  return out;
}

// The transcript plus its subagent transcripts (<id>/subagents/*.jsonl), which bill to this session.
const usageFiles = s => [s.file, ...(s.extraPaths || []).flatMap(jsonlFilesUnder)];

export function usageFingerprint(s) {
  return usageFiles(s).map(f => {
    try { return fingerprint(fs.statSync(f)); } catch { return '-'; }
  }).join(';');
}

// Claude Code writes one record per content block, all carrying the message's usage, and later
// copies can have higher output counts while streaming finishes: keep the last copy of each id.
// Returns the tallies per local day, dated by that last copy.
export async function scanUsage(s) {
  const turns = new Map();
  let anon = 0;
  for (const f of usageFiles(s)) {
    await forEachRecord(f, ['"usage"'], r => {
      const m = r.message;
      if (r.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') return;
      turns.set(m.id || `anon-${anon++}`, { m, day: dayOf(r.timestamp) });
    });
  }
  const byDay = {};
  for (const { m, day } of turns.values()) {
    const u = m.usage;
    const write = u.cache_creation_input_tokens || 0;
    const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens || 0);
    const t = {
      input: u.input_tokens || 0,
      cacheWrite5m: write - write1h,
      cacheWrite1h: write1h,
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
      webSearches: u.server_tool_use?.web_search_requests || 0,
      requests: 1,
    };
    const prompt = t.input + write + t.cacheRead;
    addTally(byDay[day] ||= {}, tallyKey(m.model || 'unknown', { prompt, fast: u.speed === 'fast' }), t);
  }
  return byDay;
}

export function launchArgs(action, session, passthrough = []) {
  if (action === 'fork') return ['--resume', session.id, '--fork-session', ...passthrough];
  if (action === 'new') return [...passthrough];
  return ['--resume', session.id, ...passthrough];
}
