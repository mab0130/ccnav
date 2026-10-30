// Shared JSONL reading: transcripts reach tens of MB, so only the ends are read.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 256 * 1024;

function readSlice(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString('utf8');
}

export function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

// Returns { stat, head, tail }; tail === head when the file fits in one read.
export function readEnds(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('not a regular file');
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(HEAD_BYTES, stat.size);
    const head = parseLines(readSlice(fd, 0, headLen), { dropLast: headLen < stat.size });
    const tailStart = Math.max(0, stat.size - TAIL_BYTES);
    const tail = stat.size > HEAD_BYTES
      ? parseLines(readSlice(fd, tailStart, stat.size - tailStart),
        { dropFirst: tailStart > 0 && readSlice(fd, tailStart - 1, 1) !== '\n' })
      : head;
    if (stat.size && !head.length && !tail.length) throw new Error('no readable JSONL records');
    return { stat, head, tail };
  } finally {
    fs.closeSync(fd);
  }
}

// Text a person typed, with injected <system-reminder>-style wrappers removed.
export function humanText(text) {
  return String(text || '').replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '').trim();
}

// Streams every record of a whole file; lines without any of `needles` are skipped unparsed,
// which keeps a full pass over hundreds of MB of transcripts to a few seconds.
export async function forEachRecord(file, needles, fn) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!needles.some(n => line.includes(n))) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      fn(r);
    }
  } finally { lines.close(); stream.destroy(); }
}

// Every *.jsonl below dir (none if it does not exist), in a stable order.
export function jsonlFilesUnder(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true }); }
  catch { return []; }
  return entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => path.join(e.parentPath ?? e.path, e.name)).sort();
}
