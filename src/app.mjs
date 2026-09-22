import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { AGENTS, ago, humanSize, providerOf } from './sessions.mjs';
import { archiveSession, copyToClipboard, isMaybeLive, openFolder, openInNewTab, searchTranscript } from './actions.mjs';

const h = React.createElement;

const SORTS = [
  { key: 'lastUsed', label: 'last used', fn: (a, b) => b.lastUsed - a.lastUsed },
  { key: 'created', label: 'created', fn: (a, b) => b.created - a.created },
  { key: 'size', label: 'size', fn: (a, b) => b.size - a.size },
  { key: 'project', label: 'directory name', fn: (a, b) => a.cwd.toLowerCase().localeCompare(b.cwd.toLowerCase()) || b.lastUsed - a.lastUsed },
];

const pad = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s.padEnd(n);
};
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const keyOf = s => `${s.agent}:${s.id}`;
const DAY = 86400 * 1000;

// mode: list | filter | confirm-archive | prune-days | confirm-prune
export function App({ sessions: initialSessions, onChoose, passthrough = [] }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns || 120;
  const height = stdout?.rows || 30;

  const [sessions, setSessions] = useState(initialSessions);
  const [cursor, setCursor] = useState(0);
  const [sortIdx, setSortIdx] = useState(0);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('list');
  const [deep, setDeep] = useState(false);
  const [deepHits, setDeepHits] = useState(null); // Map id -> snippet, for the last deep query
  const [searching, setSearching] = useState(false);
  const [showScratch, setShowScratch] = useState(false);
  const [agentIdx, setAgentIdx] = useState(0); // 0 = all agents, then one per agent
  const [message, setMessage] = useState(null); // { text, color }
  const [days, setDays] = useState('30');

  // Deep search reads whole transcripts, so it runs once per submitted query rather than per keystroke.
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(() => {
      const hits = new Map();
      for (const s of sessions) {
        const snip = searchTranscript(s, filter);
        if (snip) hits.set(keyOf(s), snip);
      }
      setDeepHits(hits);
      setSearching(false);
      setCursor(0);
    }, 10);
    return () => clearTimeout(t);
  }, [searching]);

  const sorted = useMemo(() => {
    const q = filter.toLowerCase();
    const onlyAgent = AGENTS[agentIdx - 1];
    return sessions
      .filter(s => showScratch || !s.scratch)
      .filter(s => !onlyAgent || s.agent === onlyAgent)
      .filter(s => {
        if (!q) return true;
        if (deep) return deepHits ? deepHits.has(keyOf(s)) : true;
        return [s.title, s.cwd, s.branch, s.firstPrompt, s.lastText, s.id, s.agent]
          .some(v => v && v.toLowerCase().includes(q));
      })
      .sort(SORTS[sortIdx].fn);
  }, [sessions, filter, sortIdx, showScratch, deep, deepHits, agentIdx]);

  // Group by directory; groups appear in the order of their best session under the current sort,
  // and `rows` is re-ordered to match so the cursor walks sessions top to bottom.
  const { rows, groups } = useMemo(() => {
    const byDir = new Map();
    for (const s of sorted) {
      const k = s.cwd.toLowerCase();
      if (!byDir.has(k)) byDir.set(k, { cwd: s.cwd, exists: s.cwdExists, sessions: [] });
      byDir.get(k).sessions.push(s);
    }
    const groups = [...byDir.values()];
    return { groups, rows: groups.flatMap(g => g.sessions) };
  }, [sorted]);

  const pruneTargets = useMemo(() => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1) return [];
    return rows.filter(s => Date.now() - s.lastUsed > n * DAY && !isMaybeLive(s));
  }, [rows, days]);

  const sel = rows[Math.min(cursor, rows.length - 1)];
  const listHeight = Math.max(4, height - 13);

  // Display lines: a (possibly wrapping) header per directory, then its sessions.
  const items = useMemo(() => {
    const out = [];
    let i = 0;
    for (const g of groups) {
      const label = `▾ ${g.cwd}  (${g.sessions.length}${g.exists ? '' : ', missing'})`;
      out.push({ kind: 'dir', group: g, label, lines: Math.max(1, Math.ceil(label.length / Math.max(20, width))) });
      for (const s of g.sessions) out.push({ kind: 'session', session: s, index: i++, lines: 1 });
    }
    return out;
  }, [groups, width]);

  // Pick a window of items that fits listHeight lines, keeping the cursor roughly centred.
  const visible = useMemo(() => {
    let ci = items.findIndex(it => it.kind === 'session' && it.index === cursor);
    if (ci < 0) ci = 0;
    if (!items.length) return [];
    let start = ci, end = ci + 1, used = items[ci].lines;
    const up = limit => { while (start > 0 && used + items[start - 1].lines <= limit) used += items[--start].lines; };
    const down = () => { while (end < items.length && used + items[end].lines <= listHeight) used += items[end++].lines; };
    up(Math.floor(listHeight / 2));
    down();
    up(listHeight);
    const win = items.slice(start, end);
    // Pin the directory header when the window starts mid-group.
    if (win[0]?.kind === 'session') {
      const hdrIdx = items.slice(0, start).findLastIndex(it => it.kind === 'dir');
      const hdr = { ...items[hdrIdx], label: items[hdrIdx].label + ' (cont.)' };
      let spare = listHeight - used;
      while (spare < hdr.lines && win.length > 1 && win[win.length - 1] !== items[ci]) spare += win.pop().lines;
      while (spare < hdr.lines && win.length > 1) spare += win.shift().lines;
      if (spare >= hdr.lines) win.unshift(hdr);
    }
    return win;
  }, [items, cursor, listHeight]);

  const flash = (text, color = 'green') => setMessage({ text, color });

  const requireDir = () => {
    if (sel.cwdExists) return true;
    flash(`Directory no longer exists: ${sel.cwd}`, 'red');
    return false;
  };

  const choose = action => {
    if (!sel || !requireDir()) return;
    onChoose({ action, session: sel });
    exit();
  };

  const removeSessions = gone => {
    const ids = new Set(gone.map(keyOf));
    setSessions(list => list.filter(s => !ids.has(keyOf(s))));
    setCursor(c => Math.max(0, Math.min(c, rows.length - 1 - gone.length)));
  };

  const archive = targets => {
    const done = [];
    for (const s of targets) {
      try { archiveSession(s); done.push(s); } catch (e) { flash(`Archive failed for ${s.id}: ${e.message}`, 'red'); }
    }
    removeSessions(done);
    if (done.length) flash(`Archived ${done.length} session${done.length === 1 ? '' : 's'} to the agent's ccnav-archive folder`);
  };

  useInput((input, key) => {
    setMessage(null);

    if (mode === 'filter') {
      if (key.escape) { setMode('list'); setFilter(''); setDeepHits(null); return; }
      if (key.tab) { setDeep(d => !d); setDeepHits(null); return; }
      if (key.return) { setMode('list'); if (deep && filter) setSearching(true); return; }
      if (key.backspace || key.delete) { setFilter(f => f.slice(0, -1)); setDeepHits(null); setCursor(0); return; }
      if (input && !key.ctrl && !key.meta) { setFilter(f => f + input); setDeepHits(null); setCursor(0); }
      return;
    }

    if (mode === 'confirm-archive') {
      if (input === 'y' || input === 'Y') archive([sel]);
      setMode('list');
      return;
    }

    if (mode === 'prune-days') {
      if (key.escape) { setMode('list'); return; }
      if (key.return) { setMode(pruneTargets.length ? 'confirm-prune' : 'list'); if (!pruneTargets.length) flash('Nothing that old.', 'yellow'); return; }
      if (key.backspace || key.delete) { setDays(d => d.slice(0, -1)); return; }
      if (/^\d$/.test(input)) setDays(d => (d + input).slice(0, 4));
      return;
    }

    if (mode === 'confirm-prune') {
      if (input === 'y' || input === 'Y') archive(pruneTargets);
      setMode('list');
      return;
    }

    const move = d => setCursor(c => Math.max(0, Math.min(rows.length - 1, c + d)));
    if (key.upArrow || input === 'k') move(-1);
    else if (key.downArrow || input === 'j') move(1);
    else if (key.pageUp) move(-listHeight);
    else if (key.pageDown) move(listHeight);
    else if (input === 'g') setCursor(0);
    else if (input === 'G') setCursor(rows.length - 1);
    else if (input === ']' || input === '[') {
      // Jump to the first session of the next / previous directory.
      const starts = [];
      let n = 0;
      for (const g of groups) { starts.push(n); n += g.sessions.length; }
      const cur = starts.findLastIndex(st => st <= cursor);
      const target = input === ']' ? starts[cur + 1] : (cursor > starts[cur] ? starts[cur] : starts[cur - 1]);
      if (target !== undefined) setCursor(target);
    }
    else if (key.return) choose('resume');
    else if (input === 'f') choose('fork');
    else if (input === 'n') choose('new');
    else if (input === 't' && sel && requireDir()) {
      try {
        const p = providerOf(sel);
        const where = openInNewTab(p.command, sel.cwd, p.launchArgs('resume', sel, passthrough), oneLine(sel.title) || sel.id);
        flash(`Opened "${oneLine(sel.title) || sel.id}" in a new ${where}`);
      } catch (e) { flash(`Could not open a new tab: ${e.message}`, 'red'); }
    }
    else if (input === 'o' && sel && requireDir()) { openFolder(sel.cwd); flash(`Opened ${sel.cwd}`); }
    else if (input === 'c' && sel) {
      try { copyToClipboard(sel.id); flash(`Copied ${sel.id}`); } catch (e) { flash(`Copy failed: ${e.message}`, 'red'); }
    }
    else if (input === 'x' && sel) {
      if (isMaybeLive(sel)) flash('Used in the last 10 minutes; it may still be open. Not archiving.', 'yellow');
      else setMode('confirm-archive');
    }
    else if (input === 'X') setMode('prune-days');
    else if (input === '/') setMode('filter');
    else if (input === 's') { setSortIdx(i => (i + 1) % SORTS.length); setCursor(0); }
    else if (key.tab) { setAgentIdx(i => (i + 1) % (AGENTS.length + 1)); setCursor(0); }
    else if (input === 'a') { setShowScratch(v => !v); setCursor(0); }
    else if (key.escape && filter) { setFilter(''); setDeepHits(null); setCursor(0); }
    else if (input === 'q' || key.escape) exit();
  });

  const cTitle = Math.max(20, width - 4 - 2 - 14 - 10 - 10 - 7 - 5);
  const header = pad('TITLE', cTitle) + ' ' + pad('BRANCH', 14) + ' '
    + pad('CREATED', 10) + ' ' + pad('LAST USED', 10) + ' ' + pad('SIZE', 7);
  const hiddenScratch = showScratch ? 0 : sessions.filter(s => s.scratch).length;
  const agentCounts = AGENTS
    .map(a => [a, rows.filter(s => s.agent === a).length])
    .filter(([, n]) => n)
    .map(([a, n]) => ` · ${n} ${a}`).join('');

  const filterLine = h(Text, { wrap: 'truncate' },
    h(Text, { color: mode === 'filter' ? 'yellow' : 'gray' }, deep ? 'full-text / ' : 'filter / '),
    filter || (mode === 'filter' ? '' : h(Text, { dimColor: true }, 'press / to filter')),
    mode === 'filter' ? h(Text, { inverse: true }, ' ') : null,
    mode === 'filter' ? h(Text, { dimColor: true }, deep
      ? '   tab: titles only · enter: search all transcripts'
      : '   tab: search full transcripts') : null,
    searching ? h(Text, { color: 'yellow' }, '   searching…') : null,
    deep && deepHits && !searching ? h(Text, { dimColor: true }, `   ${deepHits.size} transcripts match`) : null,
  );

  let prompt = null;
  if (mode === 'confirm-archive' && sel) {
    prompt = h(Text, { color: 'yellow' }, `Archive "${oneLine(sel.title) || sel.id}"? It moves to the ${sel.agent} ccnav-archive folder and can be moved back. (y/N)`);
  } else if (mode === 'prune-days') {
    prompt = h(Text, { color: 'yellow' }, 'Archive sessions not used in the last ', h(Text, { inverse: true }, days || ' '),
      ` days  →  ${pruneTargets.length} match (of those listed). enter to continue, esc to cancel`);
  } else if (mode === 'confirm-prune') {
    prompt = h(Text, { color: 'yellow' }, `Archive ${pruneTargets.length} sessions not used in ${days} days? (y/N)`);
  }

  const snippet = sel && deep && deepHits?.get(keyOf(sel));

  return h(Box, { flexDirection: 'column', width },
    h(Box, null,
      h(Text, { bold: true, color: 'cyan' }, 'ccnav'),
      h(Text, { dimColor: true },
        ` ${rows.length} sessions${agentCounts} · sorted by ${SORTS[sortIdx].label}`
        + (AGENTS[agentIdx - 1] ? ` · ${AGENTS[agentIdx - 1]} only (tab)` : '')
        + (hiddenScratch ? ` · ${hiddenScratch} desktop scratch hidden (a)` : '')),
    ),
    filterLine,
    h(Text, { bold: true, dimColor: true }, '      ' + header),
    ...visible.map(it => {
      if (it.kind === 'dir') {
        return h(Text, { key: 'dir:' + it.group.cwd, bold: true, color: it.group.exists ? 'cyan' : 'red', wrap: 'wrap' }, it.label);
      }
      const s = it.session;
      const p = providerOf(s);
      const active = it.index === cursor;
      const line = pad(oneLine(s.title || s.firstPrompt) || '(untitled)', cTitle) + ' '
        + pad(s.branch, 14) + ' ' + pad(ago(s.created), 10) + ' ' + pad(ago(s.lastUsed), 10) + ' '
        + pad(humanSize(s.size), 7);
      return h(Text, { key: keyOf(s), inverse: active, color: s.cwdExists ? undefined : 'red', wrap: 'truncate' },
        (active ? '  › ' : '    '),
        h(Text, { color: s.cwdExists ? p.color : 'red' }, p.glyph + ' '),
        line);
    }),
    rows.length === 0 ? h(Text, { dimColor: true }, searching ? '  searching…' : '  no sessions match') : null,
    h(Box, { marginTop: 1, flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      sel ? [
        h(Text, { key: 'p', wrap: 'truncate' }, h(Text, { dimColor: true }, 'dir    '), sel.cwd,
          sel.cwdExists ? '' : h(Text, { color: 'red' }, '  (missing)')),
        h(Text, { key: 'i', wrap: 'truncate' }, h(Text, { dimColor: true }, 'id     '), sel.id,
          h(Text, { dimColor: true }, `  ·  ${sel.agent}${sel.origin === 'desktop' ? ' (desktop/IDE)' : ''}`
            + `${sel.version ? ' ' + sel.version : ''}`
            + `  ·  started ${sel.created.toLocaleString()}  ·  last ${sel.lastUsed.toLocaleString()}`)),
        h(Text, { key: 'f', wrap: 'truncate' }, h(Text, { dimColor: true }, 'first  '), oneLine(sel.firstPrompt)),
        snippet
          ? h(Text, { key: 'm', wrap: 'truncate' }, h(Text, { dimColor: true }, 'match  '), h(Text, { color: 'yellow' }, '…' + snippet + '…'))
          : h(Text, { key: 'l', wrap: 'truncate' }, h(Text, { dimColor: true }, pad(sel.lastLabel || 'last', 7)), oneLine(sel.lastText)),
      ] : h(Text, { dimColor: true }, 'nothing selected'),
    ),
    prompt,
    message ? h(Text, { color: message.color, wrap: 'truncate' }, message.text) : null,
    h(Text, { dimColor: true, wrap: 'truncate' },
      '↑↓ move  [ ] prev/next dir  tab agent  enter resume  t new tab  f fork  n new here  o open dir  c copy id  / filter  s sort  x archive  X archive old  a scratch  q quit'),
  );
}
