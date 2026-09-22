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

const { listSessions } = await import('../src/sessions.mjs');
const { ARCHIVE_ROOT: CLAUDE_ARCHIVE } = await import('../src/providers/claude.mjs');
const { ARCHIVE_ROOT: CODEX_ARCHIVE } = await import('../src/providers/codex.mjs');
const { archiveSession, searchTranscript } = await import('../src/actions.mjs');
const { App } = await import('../src/app.mjs');

const SESSIONS = [
  ['aaaa', '2026-01-01T00:00:00Z', 'zebra'],
  ['bbbb', '2026-06-01T00:00:00Z', 'pineapple'],
  ['cccc', new Date(Date.now() - 86400e3).toISOString(), 'mango'],
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
  const write = (file, records, mtime) => {
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (mtime) fs.utimesSync(file, mtime, mtime);
  };
  const when = new Date('2026-09-19T21:11:20Z') / 1000;
  write(path.join(day, 'rollout-2026-09-19T17-02-00-cx01.jsonl'), [meta('cx01', 'cli'), user, done], when);
  write(path.join(day, 'rollout-2026-09-19T17-30-00-cx02.jsonl'),
    [meta('cx02', { subagent: { thread_spawn: { parent_thread_id: 'cx01', depth: 1 } } }), user], when);
  write(path.join(codexHome, 'session_index.jsonl'),
    [{ id: 'cx01', thread_name: 'Firewall review', updated_at: '2026-09-19T21:11:20Z' }]);
}

before(() => {
  writeCodexFixture();
  fs.mkdirSync(path.join(projectDir, 'aaaa'), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'aaaa', 'agent-side.jsonl'), '{}\n');
  for (const [id, ts, word] of SESSIONS) {
    const file = path.join(projectDir, `${id}.jsonl`);
    const lines = [
      { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' }, cwd: workDir, timestamp: ts },
      { type: 'user', message: { role: 'user', content: `hello ${id}` }, cwd: workDir, timestamp: ts, gitBranch: 'main' },
      { type: 'assistant', message: { content: [{ type: 'text', text: `the secret is ${word}` }] }, timestamp: ts },
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

test('full-text search returns the matching string, not raw JSON', () => {
  const [bbbb] = listSessions().filter(s => s.id === 'bbbb');
  assert.match(searchTranscript(bbbb, 'PINEAPPLE'), /^the secret is pineapple$/);
  assert.equal(searchTranscript(bbbb, 'zebra'), null);
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
