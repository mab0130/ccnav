import fs from 'node:fs';
import path from 'node:path';
export { askUser, copyToClipboard, ensureAgent, hasCommand, installShellFunction, launchAgent, openFolder, openInNewTab } from './platform.mjs';

// Sessions touched this recently may be open in another terminal.
export const LIVE_WINDOW_MS = 10 * 60 * 1000;
export const isMaybeLive = s => Date.now() - s.lastUsed < LIVE_WINDOW_MS;

// Case-insensitive search through the whole transcript; returns a short snippet or null.
export function searchTranscript(session, query) {
  const q = query.toLowerCase();
  let text;
  try { text = fs.readFileSync(session.file, 'utf8'); } catch { return null; }
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;
  // Prefer the matching string value from the parsed record over raw JSON.
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const lineEnd = text.indexOf('\n', idx);
  let hay = text.slice(Math.max(0, idx - 60), idx + q.length + 80);
  try {
    const found = findString(JSON.parse(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)), q);
    if (found) {
      const i = found.toLowerCase().indexOf(q);
      hay = found.slice(Math.max(0, i - 60), i + q.length + 80);
    }
  } catch { /* fall back to raw slice */ }
  return hay.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findString(v, q) {
  if (typeof v === 'string') return v.toLowerCase().includes(q) ? v : null;
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) {
      const r = findString(x, q);
      if (r) return r;
    }
  }
  return null;
}

// Moves the transcript (and any sidechain folder) into the agent's ccnav-archive, keeping the
// path it had under the sessions root, so moving it back restores the session.
export function archiveSession(session) {
  const move = (from) => {
    if (!fs.existsSync(from)) return;
    const to = path.join(session.archiveRoot, path.relative(session.root, from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  move(session.file);
  for (const extra of session.extraPaths || []) move(extra);
}

// Written for the shell wrapper function so the calling shell can cd afterwards.
export function reportCwd(dir) {
  const file = process.env.CCNAV_CWD_FILE;
  if (file) try { fs.writeFileSync(file, dir, 'utf8'); } catch { /* ignore */ }
}
