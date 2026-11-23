// Runs on every platform against a throwaway CLAUDE_CONFIG_DIR; never touches real sessions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccnav-test-"));
const config = path.join(root, 'config');
const codexHome = path.join(root, 'codex');
const workDir = path.join(root, 'work');
const projectDir = path.join(config, 'projects', 'proj');
process.env.CLAUDE_CONFIG_DIR = config;
process.env.CODEX_HOME = codexHome;
process.env.CCNAV_HOME = path.join(root, 'ccnav');

const { listSessions } = await import('../src/sessions.mjs');
const { ARCHIVE_ROOT: CLAUDE_ARCHIVE } = await import('../src/providers/claude.mjs');
const { ARCHIVE_ROOT: CODEX_ARCHIVE } = await import('../src/providers/codex.mjs');
const { archiveSession, searchTranscript } = await import('../src/actions.mjs');
const { App } = await import('../src/app.mjs');

// The subagent's request is a day later, so cx01's usage spans two days.
const CODEX_TIMES = { r1: '2026-09-19T21:05:00Z', r9: '2026-09-20T15:00:00Z' };

const SESSIONS = [
  ['aaaa', '2026-01-01T00:00:00Z', 'zebra'],
  ['bbbb', '2026-06-01T00:00:00Z', 'pineapple'],
  ['cccc', new Date(Date.now() - 86400e3).toISOString(), 'mango'],
];

const turn = (id, model, usage, extra = {}) =>
  ({ type: 'assistant', timestamp: new Date().toISOString(), ...extra, message: { id, model, content: [{ type: 'text', text: 'ok' }], usage } });
const write1h = n => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_1h_input_tokens: n, ephemeral_5m_input_tokens: 0 } });
// m1 appears twice and the later copy has the final output count; m2 is the last request.
const CCCC_TURNS = [
  turn('m1', 'claude-opus-5-5', { input_tokens: 10, ...write1h(1000), output_tokens: 5 }),
  turn('m1', 'claude-opus-5-5', { input_tokens: 10, ...write1h(1000), output_tokens: 50 }),
  turn('m2', 'claude-opus-5-5', { input_tokens: 2, cache_read_input_tokens: 1000, ...write1h(200), output_tokens: 100,
    server_tool_use: { web_search_requests: 2 } }),
];

// One Codex rollout (plus a subagent one that must stay hidden) and its index entry.
function writeCodexFixture() {
  const day = path.join(codexHome, 'sessions', '2026', '09', '19');
  fs.mkdirSync(day, { recursive: true });
  const meta = (id, source) => ({
    timestamp: '2026-09-19T21:02:21.449Z', type: 'session_meta',
    payload: { session_id: id, timestamp: '2026-09-19T21:02:00.894Z', cwd: workDir, originator: 'codex-tui', cli_version: '0.154.0', source },
  });
  const prompt = '<recommended_plugins>noise</recommended_plugins>\nreview the firewall rules';
  const user = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } };
  const done = { type: 'event_msg', timestamp: '2026-09-19T21:11:19.877Z', payload: { type: 'task_complete', last_agent_message: 'the mango rule was wrong' } };
  const turnContext = { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
  const usage = (response_id, input_tokens, cached_input_tokens, output_tokens, timestamp = CODEX_TIMES[response_id]) =>
    ({ timestamp, type: 'token_usage_record', payload: { response_id, usage: { input_tokens, cached_input_tokens, cache_write_input_tokens: 0, output_tokens } } });
  const count = { type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 }, model_context_window: 475000 } } };
  const write = (file, records, mtime) => {
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (mtime) fs.utimesSync(file, mtime, mtime);
  };
  const when = new Date('2026-09-19T21:11:20Z') / 1000;
  // r1 is recorded twice and must count once.
  write(path.join(day, 'rollout-2026-09-19T17-02-00-cx01.jsonl'),
    [meta('cx01', 'cli'), user, turnContext, usage('r1', 1000, 800, 20), usage('r1', 1000, 800, 20), count, done], when);
  // The subagent's tokens bill to cx01; a 300K prompt is past gpt-6.1-sol's long-context threshold.
  write(path.join(day, 'rollout-2026-09-19T17-30-00-cx02.jsonl'),
    [meta('cx02', { subagent: { thread_spawn: { parent_thread_id: 'cx01', depth: 1 } } }), user, turnContext, usage('r9', 300000, 0, 10)], when);
  write(path.join(codexHome, 'session_index.jsonl'),
    [{ id: 'cx01', thread_name: 'Firewall review', updated_at: '2026-09-19T21:11:20Z' }]);
}

before(() => {
  writeCodexFixture();
  fs.mkdirSync(path.join(projectDir, 'aaaa'), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'aaaa', 'agent-side.jsonl'), '{}\n');
  // A subagent of cccc on Haiku 5.5 with a 150K prompt, past its 100K long-prompt threshold.
  fs.mkdirSync(path.join(projectDir, 'cccc', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'cccc', 'subagents', 'agent-a.jsonl'),
    JSON.stringify(turn('s1', 'claude-haiku-5-5', { input_tokens: 150000, output_tokens: 10 }, { isSidechain: true })) + '\n');
  for (const [id, ts, word] of SESSIONS) {
    const file = path.join(projectDir, `${id}.jsonl`);
    const lines = [
      { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' }, cwd: workDir, timestamp: ts },
      { type: 'user', message: { role: 'user', content: `hello ${id}` }, cwd: workDir, timestamp: ts, gitBranch: 'main' },
      { type: 'assistant', message: { content: [{ type: 'text', text: `the secret is ${word}` }] }, timestamp: ts },
      ...(id === 'cccc' ? CCCC_TURNS : []),
      { type: 'ai-title', aiTitle: `Session ${id}` },
    ];
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(ts) / 1000;
    fs.utimesSync(file, t, t);
  }
});

const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

test('lists both agents, newest first, skipping sidechains and codex subagents', () => {
  const s = listSessions();
  assert.deepEqual(s.map(x => x.id), ['cccc', 'cx01', 'bbbb', 'aaaa']);
  assert.deepEqual(s.map(x => x.agent), ['claude', 'codex', 'claude', 'claude']);
  assert.equal(s[0].title, 'Session cccc');
  assert.equal(s[0].firstPrompt, 'hello cccc');
  assert.equal(s[0].cwd, workDir);
  assert.equal(s[0].branch, 'main');
});

test('reads codex metadata: title from the index, prompt without the injected block', () => {
  const [cx] = listSessions({ agents: ['codex'] });
  assert.equal(cx.title, 'Firewall review');
  assert.equal(cx.firstPrompt, 'review the firewall rules');
  assert.equal(cx.lastText, 'the mango rule was wrong');
  assert.equal(cx.cwd, workDir);
  assert.equal(cx.version, '0.154.0');
});

test('launch arguments differ per agent', async () => {
  const claude = await import('../src/providers/claude.mjs');
  const codex = await import('../src/providers/codex.mjs');
  const s = { id: 'x' };
  assert.deepEqual(claude.launchArgs('resume', s, ['--model', 'opus']), ['--resume', 'x', '--model', 'opus']);
  assert.deepEqual(claude.launchArgs('fork', s), ['--resume', 'x', '--fork-session']);
  assert.deepEqual(codex.launchArgs('resume', s), ['resume', 'x']);
  assert.deepEqual(codex.launchArgs('fork', s), ['fork', 'x']);
  assert.deepEqual(codex.launchArgs('new', s, ['-m', 'gpt']), ['-m', 'gpt']);
});

test('full-text search returns the matching string, not raw JSON', async () => {
  const [bbbb] = listSessions().filter(s => s.id === 'bbbb');
  assert.match(await searchTranscript(bbbb, 'PINEAPPLE'), /^the secret is pineapple$/);
  assert.equal(await searchTranscript(bbbb, 'zebra'), null);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await searchTranscript(bbbb, 'pineapple', cancelled.signal), null);
});

test('head/tail reads include the final record for overlapping and separate slices', async () => {
  const { readEnds } = await import('../src/jsonl.mjs');
  const filler = JSON.stringify({ type: 'filler', text: 'x'.repeat(1000) }) + '\n';
  for (const count of [300, 600]) {
    const file = path.join(root, `tail-${count}.jsonl`);
    fs.writeFileSync(file, filler.repeat(count) + JSON.stringify({ type: 'ai-title', aiTitle: `Last ${count}` }) + '\n');
    const { head, tail } = readEnds(file);
    assert.ok(head.length > 0);
    assert.equal(tail.at(-1).aiTitle, `Last ${count}`);
  }
});

test('unreadable session files are reported while other sessions remain visible', () => {
  const bad = path.join(projectDir, 'unreadable.jsonl');
  const corrupt = path.join(projectDir, 'corrupt.jsonl');
  fs.mkdirSync(bad);
  fs.writeFileSync(corrupt, '{invalid json}\n');
  try {
    const errors = [];
    const sessions = listSessions({ agents: ['claude'], onError: (agent, file, error) => errors.push({ agent, file, error }) });
    assert.equal(sessions.length, 3);
    assert.deepEqual(errors.map(e => e.file).sort(), [bad, corrupt].sort());
    assert.ok(errors.every(e => e.agent === 'claude'));
  } finally {
    fs.unlinkSync(corrupt);
    fs.rmdirSync(bad);
  }
});

test('Windows launch preserves special arguments or rejects them safely',
  { skip: process.platform !== 'win32' && 'requires PowerShell' }, async () => {
  const { launchAgent } = await import('../src/platform.mjs');
  const bin = path.join(root, 'shim-bin');
  const captured = path.join(root, 'captured-args.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'capture.mjs'),
    "import fs from 'node:fs'; fs.writeFileSync(process.env.CCNAV_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(bin, 'capture.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'capture.ps1'), `& "${process.execPath}" "$PSScriptRoot/capture.mjs" @args\nexit $LASTEXITCODE\n`);
  const saved = { path: process.env.PATH, capture: process.env.CCNAV_CAPTURE };
  process.env.PATH = `${bin}${path.delimiter}${saved.path}`;
  process.env.CCNAV_CAPTURE = captured;
  try {
    const args = ['space value', 'a&b', 'x|y', 'quote"inside', '100%', 'caret^', 'a^&b', '%COMSPEC%', '!PATH!', 'a"b&c', 'semi;colon', '$([int]42)', 'line1\r\nline2'];
    assert.equal(await launchAgent('capture', root, args), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), args);
    assert.equal(await launchAgent(process.execPath, root, ['-e', 'process.exit(7)']), 7);
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const helper = fileURLToPath(new URL('../src/windows-tab.mjs', import.meta.url));
    const spec = Buffer.from(JSON.stringify({ cmd: 'capture', cwd: root, args })).toString('base64');
    const tab = spawnSync(process.execPath, [helper, spec], { encoding: 'utf8' });
    assert.equal(tab.status, 0, tab.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), args);
    process.env.PATH = [path.join(process.env.SystemRoot, 'System32'),
      path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), bin].join(path.delimiter);
    const legacyArgs = ['space value', '--model', 'opus', 'C:\\Some Folder\\file.txt'];
    assert.equal(await launchAgent('capture', root, legacyArgs), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), legacyArgs);
    assert.equal(await launchAgent(process.execPath, root, ['-e', 'process.exit(7)']), 7);
    const originalError = console.error;
    const errors = [];
    console.error = message => errors.push(message);
    try { assert.equal(await launchAgent('capture', root, args), 127); }
    finally { console.error = originalError; }
    assert.match(errors.join(' '), /cannot safely pass these arguments/);
  } finally {
    process.env.PATH = saved.path;
    if (saved.capture === undefined) delete process.env.CCNAV_CAPTURE;
    else process.env.CCNAV_CAPTURE = saved.capture;
  }
});

test('picker groups both agents under one directory header with their glyphs', async () => {
  const t = render(React.createElement(App, { sessions: listSessions(), onChoose: () => {} }));
  await wait();
  const frame = t.lastFrame();
  assert.ok(frame.includes(`▾ ${workDir}`), frame);
  assert.ok(frame.includes('◆ Session cccc'), frame);
  assert.ok(frame.includes('● Firewall review'), frame);
  assert.ok(/3 claude/.test(frame) && /1 codex/.test(frame), frame);
  t.unmount();
});

test('picker applies an asynchronous full-transcript filter', async () => {
  const t = render(React.createElement(App, { sessions: listSessions(), onChoose: () => {} }));
  await wait();
  t.stdin.write('/'); await wait();
  t.stdin.write('\t'); await wait();
  t.stdin.write('pineapple'); await wait();
  t.stdin.write('\r');
  for (let i = 0; i < 30 && !t.lastFrame().includes('1 transcripts match'); i++) await wait(20);
  const frame = t.lastFrame();
  assert.match(frame, /1 transcripts match/);
  assert.match(frame, /Session bbbb/);
  assert.doesNotMatch(frame, /Session cccc/);
  t.unmount();
});

test('Enter hands the selected session to onChoose', async () => {
  let chosen;
  const t = render(React.createElement(App, { sessions: listSessions(), onChoose: c => { chosen = c; } }));
  await wait();
  t.stdin.write('j'); await wait();
  t.stdin.write('\r'); await wait();
  assert.equal(chosen.action, 'resume');
  assert.equal(chosen.session.id, 'cx01');
  assert.equal(chosen.session.agent, 'codex');
  t.unmount();
});

test('context size comes from the last request in the tail, for both agents', () => {
  const byId = Object.fromEntries(listSessions().map(s => [s.id, s]));
  assert.equal(byId.cccc.model, 'claude-opus-5-5');
  assert.deepEqual(byId.cccc.context, { used: 2 + 1000 + 200, window: 1_000_000 });
  assert.equal(byId.cx01.model, 'gpt-6.1-sol');
  assert.deepEqual(byId.cx01.context, { used: 1000, window: 475000 });
  assert.equal(byId.bbbb.context, null);
});

test('prices match the longest model id and apply per-request tiers', async () => {
  const { priceOf, contextWindow, costOf } = await import('../src/usage.mjs');
  assert.equal(priceOf('claude-opus-5-5').input, 4);
  assert.equal(priceOf('claude-opus-5').input, 5);
  assert.equal(priceOf('claude-fable-5').cacheRead, 1);
  assert.equal(contextWindow('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(priceOf('some-new-model'), null);
  const t = { input: 1e6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearches: 0, requests: 1 };
  assert.equal(costOf({ 'claude-haiku-5-5': t }).cost, 0.1);
  assert.equal(costOf({ 'claude-haiku-5-5@long': t }).cost, 0.5);
  assert.equal(costOf({ 'claude-opus-5-5@fast': t }).cost, 8);
  assert.deepEqual(costOf({ 'some-new-model': t }), { cost: 0, unpriced: ['some-new-model'] });
});

test('refresh reads whole transcripts once, then only the ones that changed', async () => {
  const { PROVIDERS } = await import('../src/sessions.mjs');
  const { attachUsage, costOf, loadUsageCache, refreshUsage, saveUsageCache, summaryLines } = await import('../src/usage.mjs');
  const first = await refreshUsage(listSessions(), { providers: PROVIDERS });
  assert.deepEqual([first.scanned, first.reused], [4, 0]);
  saveUsageCache(first.cache);

  const cccc = loadUsageCache().sessions['claude:cccc'].byModel;
  // m1 counted once with its final output; the subagent's request lands in the long tier.
  assert.deepEqual(cccc['claude-opus-5-5'],
    { input: 12, cacheWrite5m: 0, cacheWrite1h: 1200, cacheRead: 1000, output: 150, webSearches: 2, requests: 2 });
  assert.deepEqual(cccc['claude-haiku-5-5@long'],
    { input: 150000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, webSearches: 0, requests: 1 });
  assert.ok(Math.abs(costOf(cccc).cost - (0.012848 + 0.02 + 0.075025)) < 1e-9);

  const cx01 = loadUsageCache().sessions['codex:cx01'].byModel;
  assert.equal(cx01['gpt-6.1-sol'].requests, 1);
  assert.deepEqual([cx01['gpt-6.1-sol'].input, cx01['gpt-6.1-sol'].cacheRead], [200, 800]);
  assert.equal(cx01['gpt-6.1-sol@long'].input, 300000);

  const second = await refreshUsage(listSessions(), { providers: PROVIDERS, cache: loadUsageCache() });
  assert.deepEqual([second.scanned, second.reused], [0, 4]);

  let sessions = listSessions();
  attachUsage(sessions);
  const before = sessions.find(s => s.id === 'cccc');
  assert.ok(before.cost > 0.1 && !before.costStale);

  const file = before.file;
  fs.appendFileSync(file, JSON.stringify(turn('m3', 'claude-opus-5-5',
    { input_tokens: 2, cache_read_input_tokens: 1000, ...write1h(200), output_tokens: 1 })) + '\n');
  sessions = listSessions();
  attachUsage(sessions);
  assert.equal(sessions.find(s => s.id === 'cccc').costStale, true);
  const third = await refreshUsage(sessions, { providers: PROVIDERS, cache: loadUsageCache() });
  assert.deepEqual([third.scanned, third.reused], [1, 3]);

  const report = summaryLines(third.cache).join('\n');
  assert.match(report, /all 4 sessions/);
  assert.match(report, /claude-haiku-5-5@long/);
  assert.doesNotMatch(report, /Not priced/);
});

test('a transcript that vanishes mid-refresh is reported and the rest still saved', async () => {
  const { PROVIDERS } = await import('../src/sessions.mjs');
  const { refreshUsage } = await import('../src/usage.mjs');
  const sessions = listSessions();
  // A copy of bbbb under a new id, deleted after listing but before its scan.
  const ghost = { ...sessions.find(s => s.id === 'bbbb'), id: 'ghost', file: path.join(projectDir, 'ghost.jsonl'), extraPaths: [] };
  const errors = [];
  const r = await refreshUsage([...sessions, ghost], { all: true, providers: PROVIDERS, cache: { version: 1, sessions: {} },
    onError: (s, e) => errors.push(s.id) });
  assert.deepEqual([r.scanned, r.reused, r.failed], [4, 0, 1]);
  assert.deepEqual(errors, ['ghost']);
  assert.deepEqual(Object.keys(r.cache.sessions).sort(), ['claude:aaaa', 'claude:bbbb', 'claude:cccc', 'codex:cx01']);
});

test('usage is kept per local day, and a report can cover just a period', async () => {
  const { PROVIDERS } = await import('../src/sessions.mjs');
  const { UNDATED, dayOf, emptyTally, parseSince, refreshUsage, sumTallies, summaryLines } = await import('../src/usage.mjs');
  const now = new Date(2026, 10, 20, 12); // local noon, so these hold in any time zone
  assert.equal(parseSince('7d', now), '2026-11-14');
  assert.equal(parseSince('1d', now), '2026-11-20');
  assert.equal(parseSince('today', now), '2026-11-20');
  assert.equal(parseSince('2026-11-01', now), '2026-11-01');
  for (const bad of ['0d', 'banana', '2026-02-30', '', undefined]) assert.equal(parseSince(bad, now), null);
  assert.equal(dayOf(new Date(2026, 0, 2, 23, 59).toISOString()), '2026-01-02'); // the local day, not UTC's
  assert.equal(dayOf(undefined), UNDATED);

  // Every session's totals are exactly the sum of its days.
  const fresh = await refreshUsage(listSessions(), { all: true, providers: PROVIDERS, cache: { version: 1, sessions: {} } });
  for (const e of Object.values(fresh.cache.sessions)) assert.deepEqual(sumTallies(Object.values(e.byDay)), e.byModel);
  const cccc = fresh.cache.sessions['claude:cccc'];
  assert.deepEqual(Object.keys(cccc.byDay), [dayOf(CCCC_TURNS[0].timestamp)]);
  const cx01 = fresh.cache.sessions['codex:cx01'].byDay;
  assert.deepEqual(Object.keys(cx01).sort(), [dayOf(CODEX_TIMES.r1), dayOf(CODEX_TIMES.r9)].sort());
  assert.equal(cx01[dayOf(CODEX_TIMES.r9)]['gpt-6.1-sol@long'].input, 300000);

  // A cache entry from before daily totals is read again once, even though its transcript is unchanged.
  delete cccc.byDay;
  const again = await refreshUsage(listSessions(), { providers: PROVIDERS, cache: fresh.cache });
  assert.deepEqual([again.scanned, again.reused], [1, 3]);
  assert.ok(again.cache.sessions['claude:cccc'].byDay);

  const opus = n => ({ 'claude-opus-5-5': { ...emptyTally(), input: n, requests: 1 } });
  const cache = { version: 1, refreshedAt: now.toISOString(), sessions: {
    'claude:a': { agent: 'claude', cwd: '/a', byModel: opus(3e6), byDay: { '2026-11-10': opus(1e6), '2026-11-18': opus(2e6) } },
    'claude:old': { agent: 'claude', cwd: '/b', byModel: opus(5e6), gone: true },
    'claude:untimed': { agent: 'claude', cwd: '/c', byModel: opus(25e4), byDay: { [UNDATED]: opus(25e4) } },
  } };
  const period = summaryLines(cache, { since: '2026-11-14', daily: true }).join('\n');
  assert.match(period, /on or after 2026-11-14/);
  assert.match(period, /all 1 sessions\s+\$8\.00/); // 2M input tokens at $4 per million
  assert.match(period, /2026-11-18\s+\$8\.00/);
  assert.doesNotMatch(period, /2026-11-10/);
  assert.match(period, /1 session not counted here, from before ccnav kept daily totals: it was archived or deleted/);
  assert.match(period, /Not counted here: 250k tokens \(\$1\.00\) in 1 session with no timestamp/);
  assert.match(summaryLines(cache, { since: '2026-12-01' }).join('\n'), /No usage on or after 2026-12-01/);
  const everything = summaryLines(cache).join('\n');
  assert.match(everything, /all 3 sessions\s+\$33\.00/);
  assert.doesNotMatch(everything, /not counted/);
});

test('picker shows context and cost columns and the listed total', async () => {
  const { attachUsage } = await import('../src/usage.mjs');
  const sessions = listSessions();
  const cache = attachUsage(sessions);
  const t = render(React.createElement(App, { sessions, refreshedAt: cache.refreshedAt, onChoose: () => {} }));
  await wait();
  const frame = t.lastFrame();
  assert.match(frame, /CONTEXT\s+COST/);
  assert.match(frame, /1k 0%\s+\$0\.11/);
  assert.match(frame, /\$1\.31 est\./);
  assert.match(frame, /usage {2}claude-opus-5-5 {2}· {2}context 1k of 1M/);
  t.unmount();
});

test('`ccnav cost` reads the cache only, and says so when there is none', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/ccnav.mjs', import.meta.url));
  const env = { ...process.env, CCNAV_HOME: path.join(root, 'fresh-home') };
  const none = spawnSync(process.execPath, [bin, 'cost'], { encoding: 'utf8', env });
  assert.match(none.stdout, /Run: ccnav refresh/);
  assert.ok(!fs.existsSync(path.join(root, 'fresh-home')));
  const refresh = spawnSync(process.execPath, [bin, 'refresh'], { encoding: 'utf8', env });
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.match(refresh.stdout, /Read 4 changed sessions, 0 unchanged/);
  const cost = spawnSync(process.execPath, [bin, 'cost'], { encoding: 'utf8', env });
  assert.match(cost.stdout, /From the refresh just now/);
  assert.match(cost.stdout, /\$1\.31/);
});

test('archive moves the transcript and its sidechain folder', () => {
  const [aaaa] = listSessions().filter(s => s.id === 'aaaa');
  archiveSession(aaaa);
  const dest = path.join(CLAUDE_ARCHIVE, 'proj');
  assert.ok(fs.existsSync(path.join(dest, 'aaaa.jsonl')));
  assert.ok(fs.existsSync(path.join(dest, 'aaaa', 'agent-side.jsonl')));
  assert.ok(!fs.existsSync(path.join(projectDir, 'aaaa.jsonl')));
  assert.deepEqual(listSessions({ agents: ['claude'] }).map(s => s.id), ['cccc', 'bbbb']);
});

test('archiving a codex session keeps its dated folders', () => {
  const [cx] = listSessions({ agents: ['codex'] });
  archiveSession(cx);
  assert.ok(fs.existsSync(path.join(CODEX_ARCHIVE, '2026', '09', '19', path.basename(cx.file))));
  assert.deepEqual(listSessions({ agents: ['codex'] }), []);
});

test('shell function install is idempotent', { skip: process.platform === 'win32' && 'edits the real PowerShell profile' }, async () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR };
  Object.assign(process.env, { HOME: home, SHELL: '/bin/zsh' });
  delete process.env.ZDOTDIR;
  try {
    const { installShellFunction } = await import('../src/platform.mjs');
    fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');
    installShellFunction();
    const { file } = installShellFunction();
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(file, path.join(home, '.zshrc'));
    assert.equal(text.match(/>>> ccnav >>>/g).length, 1);
    assert.ok(text.startsWith('export FOO=1'));
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});

// Regression: after the picker closed, ccnav kept reading the console and took keystrokes from the
// agent. Needs a real console, so the fixture runs in a hidden window of its own.
test('the agent gets the terminal to itself after the picker closes',
  { skip: process.platform !== 'win32' && 'needs a real console; the POSIX pseudo-terminal leg is not written yet' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const out = path.join(root, 'tty-handoff.json');
  const lit = s => `'${String(s).replace(/'/g, "''")}'`;
  const quoted = s => lit(`"${s}"`);
  const { fileURLToPath } = await import('node:url');
  const fixture = fileURLToPath(new URL('./fixtures/tty-handoff.mjs', import.meta.url));
  const platformFile = fileURLToPath(new URL('../src/platform.mjs', import.meta.url));
  const shell = spawnSync('where', ['pwsh'], { stdio: 'ignore' }).status === 0 ? 'pwsh' : 'powershell.exe';
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath ${lit(process.execPath)} -ArgumentList ${[fixture, platformFile, out].map(quoted).join(',')}`
    + ` -WorkingDirectory ${lit(process.cwd())} -WindowStyle Hidden -Wait`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.afterInk.isTTY, true, 'the fixture did not get a console');
  assert.equal(typeof result.afterInk.reading, 'boolean', 'stdin read state is no longer observable');
  assert.equal(result.afterLaunch.destroyed, true, 'ccnav still held stdin while the agent ran');
  assert.notEqual(result.afterLaunch.reading, true, 'ccnav was still reading the console while the agent ran');
  assert.deepEqual(result.probe, { isTTY: true, raw: true });
  assert.equal(result.exitCode, 0);
});

test('an installed agent launches without prompting to install', async () => {
  const { ensureAgent, hasCommand } = await import('../src/platform.mjs');
  const self = path.basename(process.execPath); // node is on PATH while these tests run
  assert.equal(hasCommand(self), true);
  assert.equal(await ensureAgent(self), true);
});

test('a missing agent never prompts when there is no terminal to answer',
  { skip: process.platform === 'win32' && 'builds a POSIX PATH' }, async () => {
  const { ensureAgent, hasCommand, INSTALL_PKG } = await import('../src/platform.mjs');
  const bin = path.join(root, 'stubbin');
  fs.mkdirSync(bin, { recursive: true });
  const saved = { path: process.env.PATH, tty: process.stdin.isTTY };
  // A PATH with no agents on it, but still enough to resolve sh.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    assert.equal(hasCommand('codex'), false);
    // Piped output has nobody to answer, so it must decline rather than block forever.
    process.stdin.isTTY = false;
    assert.equal(await ensureAgent('codex'), false);
    assert.equal(await ensureAgent('claude'), false);
  } finally {
    process.env.PATH = saved.path;
    process.stdin.isTTY = saved.tty;
  }
  assert.deepEqual(Object.keys(INSTALL_PKG).sort(), ['claude', 'codex']);
});

test('`here` carries each agent\'s own unattended flag', async () => {
  const claude = await import('../src/providers/claude.mjs');
  const codex = await import('../src/providers/codex.mjs');
  assert.deepEqual(claude.AUTO_ARGS, ['--dangerously-skip-permissions']);
  // codex dropped --full-auto in 0.156: passing it now aborts with "unexpected argument".
  assert.deepEqual(codex.AUTO_ARGS, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.ok(!codex.AUTO_ARGS.includes('--full-auto'));
});

test('`ccnav here` starts nothing when there is no terminal and no named agent', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/ccnav.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'here'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /interactive terminal/);
});
