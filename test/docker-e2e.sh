#!/usr/bin/env bash
# End-to-end check of the non-Windows code path in a clean Linux container:
#   docker run --rm -v "$PWD:/src:ro" node:24 bash /src/test/docker-e2e.sh
set -euo pipefail

apt-get update -qq >/dev/null && apt-get install -y -qq zsh bsdutils >/dev/null

# Pack exactly what npm would publish, then install it globally from the tarball.
cp -r /src /app && rm -rf /app/node_modules && cd /app
npm ci --silent
npm test 2>&1 | grep -E '^(✔|✖|﹣)|^ℹ (pass|fail)'
tarball=$(npm pack --silent)
npm install -g --silent "./$tarball"
echo "installed: $(command -v ccnav)"

# Fake claude and codex binaries that record where and how they were launched.
mkdir -p /fakebin
for agent in claude codex; do
  printf '#!/bin/sh\necho "FAKE %s cwd=$(pwd) args=$*"\n' "$(echo $agent | tr a-z A-Z)" > /fakebin/$agent
  chmod +x /fakebin/$agent
done
export PATH="/fakebin:$PATH"

# One session per agent, both in /work/project so they share a directory group.
export CLAUDE_CONFIG_DIR=/tmp/cfg CODEX_HOME=/tmp/codex
mkdir -p /work/project "$CLAUDE_CONFIG_DIR/projects/-work-project" "$CODEX_HOME/sessions/2026/09/19"
echo '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/work/project","timestamp":"2026-09-01T00:00:00Z","gitBranch":"main"}
{"type":"ai-title","aiTitle":"Linux test session"}' > "$CLAUDE_CONFIG_DIR/projects/-work-project/1111.jsonl"
echo '{"type":"session_meta","timestamp":"2026-09-19T21:02:21Z","payload":{"session_id":"cx-linux","timestamp":"2026-09-19T21:02:00Z","cwd":"/work/project","originator":"codex-tui","cli_version":"0.154.0","source":"cli"}}
{"type":"event_msg","timestamp":"2026-09-19T21:11:19Z","payload":{"type":"task_complete","last_agent_message":"done"}}' \
  > "$CODEX_HOME/sessions/2026/09/19/rollout-2026-09-19T17-02-00-cx-linux.jsonl"

echo "--- ccnav --list"
ccnav --list

echo "--- ccnav | cat (no TTY)"
ccnav | cat || echo "exit code $?"

echo "--- install shell function for zsh (twice)"
export SHELL=/bin/zsh
ccnav --install-shell
ccnav --install-shell >/dev/null
echo "marker blocks in ~/.zshrc: $(grep -c '>>> ccnav >>>' ~/.zshrc)"

echo "--- picker in a real pty: resume the claude session (Enter), check the shell's directory"
(sleep 3; printf '\r'; sleep 2) | script -qec "zsh -ic 'cd /; ccnav --model opus; echo SHELL_PWD=\$(pwd)'" /dev/null \
  | tr -d '\r' | grep -E 'FAKE (CLAUDE|CODEX)|SHELL_PWD|→' | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'

echo "--- picker in a real pty: move down to the codex session and resume it"
(sleep 3; printf 'j'; sleep 1; printf '\r'; sleep 2) | script -qec "zsh -ic 'cd /; ccnav; echo SHELL_PWD=\$(pwd)'" /dev/null \
  | tr -d '\r' | grep -E 'FAKE (CLAUDE|CODEX)|SHELL_PWD|→' | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'
