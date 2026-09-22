// Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanText, readEnds } from '../jsonl.mjs';

export const agent = 'codex';
export const command = 'codex';
export const glyph = '●';
export const color = 'green';

export const HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SESSIONS_ROOT = path.join(HOME_DIR, 'sessions');
export const ARCHIVE_ROOT = path.join(HOME_DIR, 'ccnav-archive');
const INDEX_FILE = path.join(HOME_DIR, 'session_index.jsonl');

// session_index.jsonl names about half the sessions; read it once per listing.
function readIndex() {
  const map = new Map();
  let text;
  try { text = fs.readFileSync(INDEX_FILE, 'utf8'); } catch { return map; }
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

  let lastText = '', lastTs;
  for (const r of tail) {
    if (r.timestamp) lastTs = r.timestamp;
    const p = r.payload;
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
    title: indexed?.title || '',
    firstPrompt,
    lastText: humanText(lastText),
    lastLabel: 'reply',
    created: new Date(meta.timestamp || head[0]?.timestamp || stat.birthtime),
    lastUsed: new Date(Math.max(...stamps.map(Number))),
    size: stat.size,
    scratch: false,
  };
}

// sessions/YYYY/MM/DD/*.jsonl
export function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const index = readIndex();
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const s = readSession(p, index);
          if (s && !s.subagent) out.push(s);
        } catch { /* unreadable file */ }
      }
    }
  };
  walk(SESSIONS_ROOT, 0);
  return out;
}

export function launchArgs(action, session, passthrough = []) {
  if (action === 'fork') return ['fork', session.id, ...passthrough];
  if (action === 'new') return [...passthrough];
  return ['resume', session.id, ...passthrough];
}
