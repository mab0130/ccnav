# ccnav — Claude Codex Navigator

A terminal picker for the Claude Code and Codex sessions on this machine. Pick one and it resumes in the directory it was started in, whichever agent it belongs to.

Works on Windows, macOS and Linux with Node 20 or later. Everything that differs by OS (launching the agent, new tabs, Finder/Explorer, clipboard, shell function) is in `src/platform.mjs`; everything that differs by agent is in `src/providers/`.

## Install

```sh
npm install -g ccnav    # the -g matters
ccnav --install-shell   # optional: leave your shell in the session's directory afterwards
```

Without `-g`, npm treats the current folder as a project and puts the command in
`./node_modules/.bin`, which is not on PATH — the install succeeds and `ccnav` still
reports `command not found`. If that happens after a `-g` install, npm's global bin
folder is missing from PATH; `npm prefix -g` prints the folder whose `bin` belongs there.

From a checkout instead:

```sh
npm install
npm link                # puts `ccnav` on PATH
```

Or build a tarball once and install it anywhere:

```sh
npm pack                        # -> ccnav-1.0.0.tgz
npm install -g ./ccnav-1.0.0.tgz
```

`--install-shell` writes a function to the right file for your shell: the PowerShell `$PROFILE` on Windows, `~/.zshrc` for zsh (macOS default), `~/.bash_profile` (macOS) or `~/.bashrc` (Linux) for bash, and `~/.config/fish/functions/ccnav.fish` for fish. Running it again replaces the block rather than adding a second one.

New tabs (`t`) use Windows Terminal, iTerm2, WezTerm, kitty, GNOME Terminal or Konsole. Terminal.app gets a new window, because real tabs need Accessibility permission. On macOS the first new tab asks for permission to control the terminal; if it is refused, allow it again under System Settings → Privacy & Security → Automation.

On Windows, PowerShell 7 preserves forwarded arguments including quotes and shell characters. With the built-in Windows PowerShell 5.1 fallback, arguments containing quotes, shell characters or line breaks are rejected because its npm command shim cannot pass them safely.

## Agents

Sessions are listed whether or not the agent that wrote them is still installed, so an
old machine's transcripts stay visible. Resuming one whose agent is missing offers to
install it:

```
codex is not installed. Install it now with "npm install -g @openai/codex"? (y/N)
```

Answer `y` and ccnav runs that install, then launches the agent so you can sign in and
finish its own setup. Answer `n` and nothing is installed. `claude` maps to
`@anthropic-ai/claude-code` and `codex` to `@openai/codex`.

## Use

```
ccnav                  open the picker
ccnav --claude         only Claude Code sessions
ccnav --codex          only Codex sessions
ccnav --list           print sessions and exit
ccnav --json           print sessions as JSON and exit
ccnav --model opus     any other arguments are passed to the agent
ccnav here             new session in the current directory, running unattended
ccnav here --codex     the same, without being asked which agent
```

## Start one here

`ccnav here` ignores the session list entirely. It asks which agent, then starts a
**new** session in the current directory with that agent's permission prompts turned
off, so it runs unattended:

```
New session in /Users/you/project

  1) ◆ claude  claude --dangerously-skip-permissions
  2) ● codex   codex --dangerously-bypass-approvals-and-sandbox

Which agent? [1]
```

Pressing enter takes the first agent; `1`/`2` or a name (`codex`, `cl`) picks one.
`ccnav here --claude` or `--codex` skips the question, and any other arguments go to
the agent (`ccnav here --claude --model opus`). The exact command is printed before it
runs, and ctrl-D at the prompt starts nothing.

What those flags mean is worth being clear about. Claude's
`--dangerously-skip-permissions` bypasses every permission check. Codex's
`--dangerously-bypass-approvals-and-sandbox` skips approvals *and* runs without a
sandbox — its own help calls it EXTREMELY DANGEROUS and intends it for environments
that are already sandboxed. Neither confines the agent to the directory you started in.
Codex removed `--full-auto` in 0.156, so the sandboxed middle ground is now spelled
`--ask-for-approval never --sandbox workspace-write` if you would rather edit
`src/providers/codex.mjs` to use that instead.

| Key | Action |
|---|---|
| ↑ ↓ / j k, PgUp PgDn, g G | move |
| [ ] | jump to the previous / next directory |
| Tab | cycle agents: both → Claude → Codex |
| Enter | resume in its directory |
| t | resume in a new terminal tab (picker stays open) |
| f | fork (resume under a new session id) |
| n | new session in that directory, with the same agent |
| o | open the directory in Explorer, Finder or the Linux file manager |
| c | copy the session id |
| / | filter titles, paths, branches and prompts; Tab switches to full-transcript search |
| s | cycle sort: last used, created, size, directory name (sessions stay grouped by directory) |
| x | archive the selected session |
| X | archive every listed session not used in N days |
| a | show or hide Claude Desktop scratch sessions |
| q / Esc | quit |

`◆` in cyan marks a Claude Code session, `●` in green a Codex one.

## Where sessions come from

| | Claude Code | Codex |
|---|---|---|
| Files | `~/.claude/projects/<encoded-dir>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` |
| Override | `$CLAUDE_CONFIG_DIR` | `$CODEX_HOME` |
| Title | `ai-title` record | `thread_name` in `~/.codex/session_index.jsonl`, else the first prompt |
| Resume / fork | `claude --resume <id>` / `--fork-session` | `codex resume <id>` / `codex fork <id>` |
| Hidden | subagent sidechain folders, Desktop scratch workspaces | subagent threads spawned by other sessions |

Only the first and last 256 KB of each transcript are read when listing, so a 21 MB session costs the same as a small one. Full-text search streams each file in full and can be cancelled while it runs.

Archived sessions move to `~/.claude/ccnav-archive/` or `~/.codex/ccnav-archive/`, keeping the folders they had underneath (`<project>/` for Claude, `YYYY/MM/DD/` for Codex). Moving a file back restores it. Sessions used in the last 10 minutes are never archived, because they may still be open. Archiving a Codex session leaves its line in `session_index.jsonl`; that is harmless but not cleaned up.

## Test

```sh
npm test                                                               # unit + UI tests, any OS
docker run --rm -v "$PWD:/src:ro" node:24 bash /src/test/docker-e2e.sh # Linux install + zsh end-to-end
```
