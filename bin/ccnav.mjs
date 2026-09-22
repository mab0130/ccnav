#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from '../src/app.mjs';
import { AGENTS, PROVIDERS, ago, humanSize, listSessions, providerOf, shortPath } from '../src/sessions.mjs';
import { askUser, ensureAgent, installShellFunction, launchAgent, reportCwd } from '../src/actions.mjs';

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(`ccnav - Claude Codex Navigator: pick a Claude Code or Codex session
and resume it in its own directory

usage:
  ccnav                  open the session picker
  ccnav --claude         only Claude Code sessions
  ccnav --codex          only Codex sessions
  ccnav --list           print sessions as a table and exit
  ccnav --json           print sessions as JSON and exit
  ccnav here             skip the picker: start a NEW session in the current
                         directory, running unattended with no permission prompts
                         (ccnav here --claude / --codex picks the agent outright)
  ccnav --install-shell  add a shell function (PowerShell, zsh, bash or fish) so
                         your shell is left in the session's directory afterwards

Any other arguments are passed to the agent (e.g. ccnav --model opus).`);
  process.exit(0);
}

// `ccnav here` never touches the session list: it starts a new one in this directory.
async function chooseAgent() {
  if (!process.stdin.isTTY) {
    console.error('ccnav here needs an interactive terminal, or name the agent: ccnav here --claude');
    process.exit(1);
  }
  console.log(`\nNew session in ${process.cwd()}\n`);
  AGENTS.forEach((a, i) => {
    const p = PROVIDERS[a];
    console.log(`  ${i + 1}) ${p.glyph} ${a.padEnd(7)} ${p.command} ${p.AUTO_ARGS.join(' ')}`);
  });
  const answer = await askUser(`\nWhich agent? [1] `);
  // EOF is not a choice: never start an unattended agent nobody actually asked for.
  if (answer === null) { console.error('\nNo answer given, nothing started.'); process.exit(1); }
  if (!answer) return AGENTS[0];
  const byNumber = AGENTS[Number(answer) - 1];
  if (byNumber) return byNumber;
  const byName = AGENTS.find(a => a.startsWith(answer.toLowerCase()));
  if (byName) return byName;
  console.error(`Not an agent: ${answer}`);
  process.exit(1);
}

if (args[0] === 'here') {
  const rest = args.slice(1);
  const named = AGENTS.find(a => rest.includes(`--${a}`));
  const extra = rest.filter(a => a !== '--' && !AGENTS.some(x => a === `--${x}`));
  const provider = PROVIDERS[named || await chooseAgent()];
  if (!await ensureAgent(provider.command)) process.exit(127);
  const argv = [...provider.AUTO_ARGS, ...extra];
  console.log(`\n\u2192 ${process.cwd()}\n\u2192 ${provider.command} ${argv.join(' ')}\n`);
  process.exit(await launchAgent(provider.command, process.cwd(), argv));
}

if (args.includes('--install-shell')) {
  const { shell, file, reload } = installShellFunction();
  console.log(`ccnav ${shell} function written to ${file}\nto use it now: ${reload}`);
  process.exit(0);
}

// PowerShell swallows a bare `--`, so anything ccnav doesn't recognise goes to the agent.
const OWN_FLAGS = new Set(['--list', '--json', '--install-shell', '--claude', '--codex', '-h', '--help', '--']);
const passthrough = args.filter(a => !OWN_FLAGS.has(a));
const agents = ['claude', 'codex'].filter(a => args.includes(`--${a}`));
const sessions = listSessions(agents.length ? { agents } : {});

if (args.includes('--json')) {
  console.log(JSON.stringify(sessions, null, 2));
  process.exit(0);
}

if (args.includes('--list')) {
  for (const s of sessions) {
    console.log([s.agent.padEnd(6), ago(s.lastUsed).padEnd(9), ago(s.created).padEnd(9), humanSize(s.size).padStart(6),
      shortPath(s.cwd).padEnd(40), (s.title || s.firstPrompt).replace(/\s+/g, ' ').slice(0, 60)].join('  '));
  }
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error('ccnav needs an interactive terminal (use --list or --json otherwise)');
  process.exit(1);
}

let choice = null;
const app = render(React.createElement(App, { sessions, passthrough, onChoose: c => { choice = c; } }));
await app.waitUntilExit();

if (!choice) process.exit(0);
const { action, session } = choice;

const provider = providerOf(session);
const agentArgs = provider.launchArgs(action, session, passthrough);

// The agent may not be installed yet; offer to install it rather than just failing.
if (!await ensureAgent(provider.command)) process.exit(127);

reportCwd(session.cwd);
console.log(`\n→ ${session.cwd}\n→ ${provider.command} ${agentArgs.join(' ')}\n`);
process.exit(await launchAgent(provider.command, session.cwd, agentArgs));
