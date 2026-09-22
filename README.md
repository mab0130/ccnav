# ccnav — Claude Codex Navigator

A terminal picker for the Claude Code and Codex sessions on this machine. Pick one and it resumes in the directory it was started in, whichever agent it belongs to.

Works on Windows, macOS and Linux with Node 20 or later. Everything that differs by OS (launching the agent, new tabs, Finder/Explorer, clipboard, shell function) is in `src/platform.mjs`; everything that differs by agent is in `src/providers/`.

## Install

From a checkout (any OS):

```sh
npm install
npm link                # puts `ccnav` on PATH
ccnav --install-shell   # optional: leave your shell in the session's directory afterwards
```

Or build a tarball once and install it anywhere, e.g. on a Mac:

```sh
npm pack                        # -> ccnav-1.0.0.tgz
npm install -g ./ccnav-1.0.0.tgz
```

`--install-shell` writes a function to the right file for your shell: the PowerShell `$PROFILE` on Windows, `~/.zshrc` for zsh (macOS default), `~/.bash_profile` (macOS) or `~/.bashrc` (Linux) for bash, and `~/.config/fish/functions/ccnav.fish` for fish. Running it again replaces the block rather than adding a second one.

New tabs (`t`) use Windows Terminal, iTerm2, WezTerm, kitty, GNOME Terminal or Konsole. Terminal.app gets a new window, because real tabs need Accessibility permission.

## Use

```
ccnav                  open the picker
ccnav --claude         only Claude Code sessions
ccnav --codex          only Codex sessions
ccnav --list           print sessions and exit
ccnav --json           print sessions as JSON and exit
ccnav --model opus     any other arguments are passed to the agent
```

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

Only the first and last 256 KB of each transcript are read when listing, so a 21 MB session costs the same as a small one. Full-text search reads whole files.

Archived sessions move to `~/.claude/ccnav-archive/` or `~/.codex/ccnav-archive/`, keeping the folders they had underneath (`<project>/` for Claude, `YYYY/MM/DD/` for Codex). Moving a file back restores it. Sessions used in the last 10 minutes are never archived, because they may still be open. Archiving a Codex session leaves its line in `session_index.jsonl`; that is harmless but not cleaned up.

## Test

```sh
npm test                                                               # unit + UI tests, any OS
docker run --rm -v "$PWD:/src:ro" node:24 bash /src/test/docker-e2e.sh # Linux install + zsh end-to-end
```
