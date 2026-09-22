#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from '../src/app.mjs';
import { ago, humanSize, listSessions, providerOf, shortPath } from '../src/sessions.mjs';
import { installShellFunction, launchAgent, reportCwd } from '../src/actions.mjs';

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
  ccnav --install-shell  add a shell function (PowerShell, zsh, bash or fish) so
                         your shell is left in the session's directory afterwards

Any other arguments are passed to the agent (e.g. ccnav --model opus).`);
  process.exit(0);
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

reportCwd(session.cwd);
console.log(`\n→ ${session.cwd}\n→ ${provider.command} ${agentArgs.join(' ')}\n`);
process.exit(await launchAgent(provider.command, session.cwd, agentArgs));
