// Token usage, context size and estimated cost.
// Listing only reads the cached tallies; `ccnav refresh` is the one thing that reads whole transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CCNAV_HOME = process.env.CCNAV_HOME || path.join(os.homedir(), '.ccnav');
export const CACHE_FILE = path.join(CCNAV_HOME, 'usage.json');
export const PRICES_FILE = path.join(CCNAV_HOME, 'prices.json');

// List prices in USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing and
// openai.com/index/introducing-gpt-6-1-sol. cacheWrite5m / cacheWrite1h default to 1.25x / 2x input.
// `long` applies to a whole request whose prompt exceeds `over` tokens; `fast` multiplies everything.
export const PRICES_AS_OF = '2026-10-30';
export const DEFAULT_WINDOW = 1_000_000;
const BUILTIN_PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, window: 200_000 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, window: 200_000 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, window: 200_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, window: 200_000 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, window: 200_000 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, window: 200_000 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, window: 200_000 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, long: { over: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite5m: 5 } },
};
export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

// ~/.ccnav/prices.json can add models or override any of the above, in the same shape.
function loadPrices() {
  try { return { ...BUILTIN_PRICES, ...JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')) }; }
  catch { return BUILTIN_PRICES; }
}
export const PRICES = loadPrices();

// Longest key contained in the id, so `claude-opus-5-5` beats `claude-opus-5` and dated
// (`-20251001`) or provider-prefixed (`anthropic.`) ids still match.
export function priceOf(model, prices = PRICES) {
  const id = String(model || '').toLowerCase();
  let best = null;
  for (const key of Object.keys(prices)) if (id.includes(key) && (!best || key.length > best.length)) best = key;
  return best ? prices[best] : null;
}

export function contextWindow(model) {
  return priceOf(model)?.window || DEFAULT_WINDOW;
}

// Tallies are keyed by model plus the per-request pricing tier, e.g. `claude-haiku-5-5@long`
// or `claude-opus-5-5@fast`; prices are applied when displayed, so a price change needs no rescan.
const FIELDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'webSearches', 'requests'];
export const emptyTally = () => Object.fromEntries(FIELDS.map(f => [f, 0]));

export function tallyKey(model, { prompt = 0, fast = false } = {}) {
  const p = priceOf(model);
  let key = model;
  if (p?.long && prompt > p.long.over) key += '@long';
  if (fast) key += '@fast';
  return key;
}

export function addTally(byModel, key, t) {
  const into = byModel[key] ||= emptyTally();
  for (const f of FIELDS) into[f] += t[f] || 0;
}

export function tokensOf(t) {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;
}

// Returns { cost, unpriced } for a byModel tally map; unpriced lists models with no known price.
export function costOf(byModel = {}) {
  let cost = 0;
  const unpriced = new Set();
  for (const [key, t] of Object.entries(byModel)) {
    const [model, ...tags] = key.split('@');
    const base = priceOf(model);
    if (!base) { if (tokensOf(t)) unpriced.add(model); continue; }
    const p = tags.includes('long') && base.long ? { ...base, ...base.long } : base;
    const mult = tags.includes('fast') ? base.fast || 1 : 1;
    const w5 = p.cacheWrite5m ?? p.input * 1.25;
    const w1 = p.cacheWrite1h ?? p.input * 2;
    cost += mult * (t.input * p.input + t.cacheWrite5m * w5 + t.cacheWrite1h * w1
      + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
    cost += t.webSearches * WEB_SEARCH_USD;
  }
  return { cost, unpriced: [...unpriced] };
}

export function sumTallies(list) {
  const out = {};
  for (const byModel of list) for (const [k, t] of Object.entries(byModel || {})) addTally(out, k, t);
  return out;
}

// --- days ---

// Usage is bucketed by the local calendar day of each request, as YYYY-MM-DD.
export const UNDATED = 'undated';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function dayOf(ts) {
  const d = new Date(ts);
  return ts && !Number.isNaN(d.getTime()) ? ymd(d) : UNDATED;
}

// `7d` is today and the six days before it; a YYYY-MM-DD date is taken as is. Null when unrecognised.
export function parseSince(text, now = new Date()) {
  const s = String(text || '').trim().toLowerCase();
  if (s === 'today') return ymd(now);
  const n = /^(\d+)d$/.exec(s);
  if (n && Number(n[1]) >= 1) return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Number(n[1]) - 1)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && dayOf(`${s}T12:00:00`) === s) return s;
  return null;
}

const inPeriod = (day, since) => day !== UNDATED && (!since || day >= since);

// --- the cache written by `ccnav refresh` ---

export const fingerprint = stat => `${stat.size}:${Math.round(stat.mtimeMs)}`;
export const usageKey = s => `${s.agent}:${s.id}`;

export function loadUsageCache(file = CACHE_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version === 1 && data.sessions) return data;
  } catch { /* none yet, or unreadable: treated as never refreshed */ }
  return { version: 1, refreshedAt: null, sessions: {} };
}

export function saveUsageCache(cache, file = CACHE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

// Puts the cached tallies on each session. `costStale` means the transcript changed after the refresh.
export function attachUsage(sessions, cache = loadUsageCache()) {
  for (const s of sessions) {
    const entry = cache.sessions[usageKey(s)];
    if (!entry) continue;
    s.usage = entry.byModel;
    s.cost = costOf(entry.byModel).cost;
    s.costStale = entry.mainFp !== s.fingerprint;
  }
  return cache;
}

// Scans every session whose files changed since the last refresh (all of them with `all`).
// Entries for sessions that are no longer listed (archived or deleted) are kept, flagged `gone`,
// so the total still counts money already spent.
export async function refreshUsage(sessions, {
  all = false, cache = loadUsageCache(), providers, onProgress = () => {},
  onError = (s, error) => console.error(`ccnav: could not read usage for ${s.file}: ${error.message}`),
} = {}) {
  let scanned = 0, reused = 0, failed = 0;
  const listed = new Set();
  for (const [i, s] of sessions.entries()) {
    const key = usageKey(s);
    listed.add(key);
    const provider = providers[s.agent];
    const fullFp = provider.usageFingerprint(s);
    const prev = cache.sessions[key];
    onProgress(i + 1, sessions.length, s);
    // Entries from before daily totals were kept are read again once, to add them.
    if (!all && prev && prev.fp === fullFp && prev.byDay) { prev.gone = false; reused++; continue; }
    // A transcript archived or locked mid-refresh keeps its previous entry and fingerprint,
    // so the next refresh tries it again; the rest of the run still gets saved.
    let byDay;
    try { byDay = await provider.scanUsage(s); }
    catch (error) { onError(s, error); failed++; if (prev) prev.gone = false; continue; }
    // The session totals are the sum of its days, so the two can never disagree.
    cache.sessions[key] = { agent: s.agent, id: s.id, cwd: s.cwd, title: s.title || s.firstPrompt?.slice(0, 80) || '',
      fp: fullFp, mainFp: s.fingerprint, byModel: sumTallies(Object.values(byDay)), byDay, gone: false };
    scanned++;
  }
  for (const [key, entry] of Object.entries(cache.sessions)) if (!listed.has(key)) entry.gone = true;
  cache.refreshedAt = new Date().toISOString();
  return { cache, scanned, reused, failed };
}

// --- formatting ---

export function humanTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  if (n < 1e9) return `${+(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${+(n / 1e9).toFixed(2)}B`;
}

export function money(n) {
  if (n == null) return '';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

export function contextLabel(ctx) {
  if (!ctx?.used) return '';
  return `${humanTokens(ctx.used)} ${Math.round((ctx.used / ctx.window) * 100)}%`;
}

// The report printed by `ccnav refresh` and `ccnav cost`. `since` (YYYY-MM-DD) limits it to usage on
// or after that day; `daily` adds a by-day section. Sessions with no daily totals cannot be placed in a
// period, so they are left out of one and the report says how many.
export function summaryLines(cache, { top = 10, shortPath = p => p, since = null, daily = false } = {}) {
  const recorded = Object.values(cache.sessions);
  if (!recorded.length) return ['No usage recorded yet. Run: ccnav refresh'];
  const undated = recorded.filter(e => !e.byDay);
  const entries = !since ? recorded : recorded.flatMap(e => {
    if (!e.byDay) return [];
    const byModel = sumTallies(Object.entries(e.byDay).filter(([day]) => inPeriod(day, since)).map(([, t]) => t));
    return Object.values(byModel).some(t => tokensOf(t) || t.webSearches) ? [{ ...e, byModel }] : [];
  });
  // Requests with no readable timestamp belong to no day, so a period or daily view cannot count them either.
  const untimed = recorded.filter(e => e.byDay?.[UNDATED]);
  const notCounted = () => {
    const out = [];
    if (undated.length) {
      const n = undated.length, refreshable = undated.filter(e => !e.gone).length, gone = n - refreshable;
      const parts = [];
      if (refreshable) parts.push(`ccnav refresh adds ${refreshable === n ? 'them' : refreshable}`);
      if (gone) parts.push(`${gone === n ? (n === 1 ? 'it was' : 'they were') : `${gone} were`} archived or deleted, so cannot be read again`);
      out.push(`${n} session${n === 1 ? '' : 's'} not counted here, from before ccnav kept daily totals: ${parts.join('; ')}.`);
    }
    if (untimed.length) {
      const t = sumTallies(untimed.map(e => e.byDay[UNDATED]));
      out.push(`Not counted here: ${humanTokens(Object.values(t).reduce((a, x) => a + tokensOf(x), 0))} tokens`
        + ` (${money(costOf(t).cost)}) in ${untimed.length} session${untimed.length === 1 ? '' : 's'} with no timestamp on the request.`);
    }
    return out;
  };
  if (!entries.length) return [`No usage on or after ${since}.`, ...notCounted()];
  const row = (label, byModel, extra = '') => {
    const { cost } = costOf(byModel);
    const t = Object.values(byModel).reduce((a, x) => a + tokensOf(x), 0);
    return `  ${label.padEnd(34)} ${money(cost).padStart(11)}  ${humanTokens(t).padStart(7)} tokens${extra}`;
  };
  // Grouped case-insensitively, as the picker does, and labelled with the first spelling seen.
  const group = keyFn => {
    const m = new Map();
    for (const e of entries) {
      const label = keyFn(e), k = label.toLowerCase();
      if (!m.has(k)) m.set(k, { label, list: [] });
      m.get(k).list.push(e.byModel);
    }
    return [...m.values()].map(({ label, list }) => [label, sumTallies(list)])
      .sort((a, b) => costOf(b[1]).cost - costOf(a[1]).cost);
  };
  const all = sumTallies(entries.map(e => e.byModel));
  const gone = entries.filter(e => e.gone);
  const out = [`Estimated cost at API list prices (prices as of ${PRICES_AS_OF})`
    + (since ? `, for usage on or after ${since}` : ''), ''];
  out.push(row(`all ${entries.length} sessions`, all));
  for (const [agent, t] of group(e => e.agent)) out.push(row(agent, t));
  if (gone.length) out.push(row(`  of which archived or deleted (${gone.length})`, sumTallies(gone.map(e => e.byModel))));

  if (daily) {
    const days = new Map();
    for (const e of entries) {
      for (const [day, t] of Object.entries(e.byDay || {})) if (inPeriod(day, since)) days.set(day, sumTallies([days.get(day), t]));
    }
    const newest = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const shown = since ? newest : newest.slice(0, 31);
    out.push('', `by day${shown.length < newest.length ? ` (latest ${shown.length} of ${newest.length}; --since for more)` : ''}`);
    for (const [day, t] of shown) out.push(row(day, t));
  }
  if (since || daily) out.push(...notCounted().map(l => `  ${l}`));

  out.push('', 'by model');
  const byModel = Object.entries(all).map(([k, t]) => [k, { [k]: t }])
    .sort((a, b) => costOf(b[1]).cost - costOf(a[1]).cost);
  for (const [k, t] of byModel) out.push(row(k, t, `  ${t[k].requests.toLocaleString('en-US')} requests`));

  const dirs = group(e => e.cwd || '?');
  out.push('', `by directory${dirs.length > top ? ` (top ${top} of ${dirs.length})` : ''}`);
  for (const [dir, t] of dirs.slice(0, top)) {
    const label = shortPath(dir);
    out.push(row(label.length > 34 ? '…' + label.slice(-33) : label, t));
  }

  const { unpriced } = costOf(all);
  out.push('');
  if (unpriced.length) out.push(`Not priced (add them to ${PRICES_FILE}): ${unpriced.join(', ')}`);
  out.push('List-price estimate: subscription plans bill differently. Web search is included; other',
    'server-tool fees, batch and regional pricing are not. Forked sessions can count shared history twice.');
  return out;
}
