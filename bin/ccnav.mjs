#!/usr/bin/env node
import { AGENTS, PROVIDERS, ago, humanSize, listSessions, providerOf, shortPath } from '../src/sessions.mjs';
import { askUser, ensureAgent, installShellFunction, launchAgent, reportCwd } from '../src/actions.mjs';
import { CACHE_FILE, attachUsage, contextLabel, loadUsageCache, money, parseSince, refreshUsage, saveUsageCache, summaryLines } from '../src/usage.mjs';

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
  ccnav refresh          read every changed transcript in full and update token and
                         cost totals, then print them (--all rereads everything)
  ccnav cost             print the totals from the last refresh without reading
                         any transcripts
      --since 7d         (refresh or cost) only usage from the last 7 days, or
      --since 2026-11-01 on or after a date; days are local calendar days
      --daily            (refresh or cost) add a cost-per-day table
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

// `--since 7d` / `--since 2026-11-01` and `--daily`, shared by refresh and cost.
function reportOptions() {
  const i = args.indexOf('--since');
  const raw = i >= 0 ? args[i + 1] : null;
  const since = i >= 0 ? parseSince(raw) : null;
  if (i >= 0 && !since) {
    console.error(`--since needs a number of days or a date, e.g. --since 7d or --since 2026-11-01 (got ${raw ?? 'nothing'})`);
    process.exit(1);
  }
  return { shortPath, since, daily: args.includes('--daily') };
}

// Cost is the one thing that needs whole transcripts, so it is only ever read here, on request.
if (args[0] === 'refresh') {
  const report = reportOptions();
  const started = Date.now();
  const sessions = listSessions();
  const tty = process.stderr.isTTY;
  const { cache, scanned, reused, failed } = await refreshUsage(sessions, {
    all: args.includes('--all'),
    providers: PROVIDERS,
    onProgress: (i, n) => { if (tty && (i % 5 === 0 || i === n)) process.stderr.write(`\rreading transcripts ${i}/${n}`); },
  });
  if (tty) process.stderr.write('\r\x1b[K');
  saveUsageCache(cache);
  console.log(`Read ${scanned} changed session${scanned === 1 ? '' : 's'}, ${reused} unchanged, `
    + (failed ? `${failed} unreadable (kept their previous totals), ` : '')
    + `in ${((Date.now() - started) / 1000).toFixed(1)}s. Saved to ${CACHE_FILE}\n`);
  console.log(summaryLines(cache, report).join('\n'));
  process.exit(0);
}

if (args[0] === 'cost') {
  const report = reportOptions();
  const cache = loadUsageCache();
  if (!cache.refreshedAt) { console.log('No usage recorded yet. Run: ccnav refresh'); process.exit(0); }
  const sessions = listSessions();
  attachUsage(sessions, cache);
  const changed = sessions.filter(s => s.cost == null || s.costStale).length;
  console.log(`From the refresh ${ago(new Date(cache.refreshedAt))}`
    + (changed ? `; ${changed} session${changed === 1 ? ' has' : 's have'} changed since (ccnav refresh to update)` : '') + '\n');
  console.log(summaryLines(cache, report).join('\n'));
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
const usageCache = attachUsage(sessions);

if (args.includes('--json')) {
  console.log(JSON.stringify(sessions, null, 2));
  process.exit(0);
}

if (args.includes('--list')) {
  for (const s of sessions) {
    console.log([s.agent.padEnd(6), ago(s.lastUsed).padEnd(9), ago(s.created).padEnd(9), humanSize(s.size).padStart(6),
      contextLabel(s.context).padStart(9), (money(s.cost) + (s.costStale ? '+' : '')).padStart(9),
      shortPath(s.cwd).padEnd(40), (s.title || s.firstPrompt).replace(/\s+/g, ' ').slice(0, 60)].join('  '));
  }
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error('ccnav needs an interactive terminal (use --list or --json otherwise)');
  process.exit(1);
}

// Ink and React take most of a second to load, so only the picker pays for them.
const [{ default: React }, { render }, { App }] = await Promise.all([import('react'), import('ink'), import('../src/app.mjs')]);
let choice = null;
const app = render(React.createElement(App, { sessions, passthrough, refreshedAt: usageCache.refreshedAt, onChoose: c => { choice = c; } }));
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
