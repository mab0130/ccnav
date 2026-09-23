// Shared JSONL reading: transcripts reach tens of MB, so only the ends are read.
import fs from 'node:fs';

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
