import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { setImmediate as yieldToUi } from 'node:timers/promises';
export { askUser, copyToClipboard, ensureAgent, hasCommand, installShellFunction, launchAgent, openFolder, openInNewTab } from './platform.mjs';

// Sessions touched this recently may be open in another terminal.
export const LIVE_WINDOW_MS = 10 * 60 * 1000;
export const isMaybeLive = s => Date.now() - s.lastUsed < LIVE_WINDOW_MS;

// Stream the transcript so a search does not block the picker or load whole files into memory.
export async function searchTranscript(session, query, signal) {
  if (!query || signal?.aborted) return null;
  const q = query.toLowerCase();
  const stream = fs.createReadStream(session.file, { encoding: 'utf8', signal });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let count = 0;
    for await (const line of lines) {
      if (signal?.aborted) return null;
      if (++count % 256 === 0) await yieldToUi();
      const idx = line.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      // Prefer the matching string value from the parsed record over raw JSON.
      let hay = line.slice(Math.max(0, idx - 60), idx + q.length + 80);
      try {
        const found = findString(JSON.parse(line), q);
        if (found) {
          const i = found.toLowerCase().indexOf(q);
          hay = found.slice(Math.max(0, i - 60), i + q.length + 80);
        }
      } catch { /* fall back to the raw line */ }
      return hay.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch { /* unreadable or cancelled transcript */ }
  finally { lines.close(); stream.destroy(); }
  return null;
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
