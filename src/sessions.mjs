import os from 'node:os';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';

export const PROVIDERS = { claude, codex };
export const AGENTS = Object.keys(PROVIDERS);

const reportError = (agent, file, error) =>
  console.error(`ccnav: could not read ${agent} sessions${file ? ` at ${file}` : ''}: ${error.message}`);

// Both agents' sessions in one list, newest use first. Report unreadable sources on stderr.
export function listSessions({ agents = AGENTS, onError = reportError } = {}) {
  const out = [];
  for (const name of agents) {
    const provider = PROVIDERS[name];
    if (!provider) { onError(name, null, new Error('unknown agent')); continue; }
    try { out.push(...provider.listSessions({ onError: (file, error) => onError(name, file, error) })); }
    catch (error) { onError(name, null, error); }
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

export function providerOf(session) {
  return PROVIDERS[session.agent] || PROVIDERS.claude;
}

export function ago(date, now = Date.now()) {
  const s = Math.max(0, (now - date) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo ago`;
  return `${Math.floor(s / 86400 / 365)}y ago`;
}

export function humanSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)}K`;
  return `${(n / 1024 ** 2).toFixed(1)}M`;
}

export function shortPath(p) {
  const home = os.homedir();
  return p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p;
}
