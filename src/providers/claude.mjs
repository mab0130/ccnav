// Claude Code sessions: ~/.claude/projects/<encoded-dir>/<session-id>.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanText, readEnds } from '../jsonl.mjs';

export const agent = 'claude';
export const command = 'claude';
export const glyph = '◆';
export const color = 'cyan';

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
  let title, lastPrompt, lastTs, bridge, lastCwd, branch;
  for (const r of tail) {
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
    // Claude Desktop scratch folders: %APPDATA%\Claude\... on Windows, ~/Library/Application Support/Claude/... on macOS.
    scratch: /[\\/]Claude[\\/]scratch-workspaces[\\/]/i.test(cwd),
  };
}

// Top-level *.jsonl only: <sessionId>/ subdirectories hold subagent sidechains.
export function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out = [];
  for (const dir of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(SESSIONS_ROOT, dir.name);
    for (const f of fs.readdirSync(projectDir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const s = readSession(path.join(projectDir, f));
        if (s) out.push(s);
      } catch { /* unreadable file */ }
    }
  }
  return out;
}

export function launchArgs(action, session, passthrough = []) {
  if (action === 'fork') return ['--resume', session.id, '--fork-session', ...passthrough];
  if (action === 'new') return [...passthrough];
  return ['--resume', session.id, ...passthrough];
}
