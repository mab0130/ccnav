// Everything that differs between Windows, macOS and Linux lives here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const has = cmd => IS_WIN
  ? spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0
  : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// Exported so the picker can warn before opening a tab that would only fail.
export const hasCommand = has;

// POSIX single-quote escaping for building `sh -c` / AppleScript command lines.
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const osaString = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// Encode the command and argv as data before handing them to PowerShell.
function windowsCommand(cmd, args, { keepOpen = false } = {}) {
  const spec = Buffer.from(JSON.stringify({ command: cmd, args }), 'utf8').toString('base64');
  const run = `$ErrorActionPreference = 'Stop'; $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${spec}')) | ConvertFrom-Json; $arguments = [string[]]$spec.args; $global:LASTEXITCODE = 0; try { & $spec.command @arguments } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 127 }`;
  const script = keepOpen ? run : `${run}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const shell = has('pwsh') ? 'pwsh' : 'powershell.exe';
  return [shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', ...(keepOpen ? ['-NoExit'] : []), '-EncodedCommand', encoded]];
}

// PowerShell 5 changes quoted arguments when its npm .ps1 shim forwards them to Node.
// For that fallback, use the .cmd shim and reject values it can reinterpret.
function legacyWindowsArgs(cmd, args) {
  if (args.some(arg => /\0/.test(String(arg)))) return null;
  const extension = path.extname(cmd).toLowerCase();
  const where = spawnSync('where', [cmd], { encoding: 'utf8' });
  const found = String(where.stdout || '').split(/\r?\n/);
  const cmdShim = extension === '.cmd' || extension === '.bat'
    || (extension !== '.exe' && found.some(p => /\.(cmd|bat)$/i.test(p)));
  if (cmdShim && args.some(arg => /[\r\n"%!^&|<>]/.test(String(arg)))) return null;
  return args;
}

export const INSTALL_PKG = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};
const hint = cmd => INSTALL_PKG[cmd] ? ` Install it: npm install -g ${INSTALL_PKG[cmd]}` : '';

// Before the agent takes over the terminal, ccnav must stop reading it. Ink only turns raw mode off
// and detaches its listener; the stream keeps reading, and on Windows that leaves a ReadConsole call
// pending in this process that wins keystrokes (Ctrl+C too) from the agent sharing the console.
// pause() does not stop a TTY read; closing the handle does. libuv reads through its own duplicate of
// the console handle (and never closes fd 0-2 on POSIX), so the child still inherits a working fd 0.
async function releaseStdin() {
  const stdin = process.stdin;
  const state = label => process.env.CCNAV_DEBUG && fs.appendFileSync(path.join(os.tmpdir(), 'ccnav-debug.log'),
    `${new Date().toISOString()} ${label} isTTY=${stdin.isTTY} isRaw=${stdin.isRaw} reading=${stdin._handle?.reading}`
    + ` flowing=${stdin.readableFlowing} destroyed=${stdin.destroyed} data=${stdin.listenerCount('data')}`
    + ` readable=${stdin.listenerCount('readable')} keypress=${stdin.listenerCount('keypress')}\n`);
  try {
    state('before');
    if (!stdin.isTTY || stdin.destroyed) return;
    try { if (stdin.isRaw) stdin.setRawMode(false); } catch { /* already restored */ }
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('readable');
    stdin.removeAllListeners('keypress');
    stdin.pause();
    await new Promise(done => {
      const timer = setTimeout(done, 250);
      stdin.once('close', () => { clearTimeout(timer); done(); });
      stdin.destroy();
    });
    state('after');
  } catch { /* never block the launch on this */ }
}

// Runs the agent in the foreground with the session's directory as cwd; resolves with its exit code.
export async function launchAgent(cmd, cwd, args) {
  await releaseStdin();
  return new Promise(resolve => {
    const legacy = IS_WIN && !has('pwsh');
    const passedArgs = legacy ? legacyWindowsArgs(cmd, args) : args;
    if (passedArgs === null) {
      console.error('could not start agent: Windows PowerShell 5 cannot safely pass these arguments through a command shim; use PowerShell 7');
      resolve(127);
      return;
    }
    const [shell, shellArgs] = IS_WIN && !legacy ? windowsCommand(cmd, args) : [cmd, passedArgs];
    const fail = e => {
      console.error(e.code === 'ENOENT'
        ? `${shell} was not found on PATH.${shell === cmd ? hint(cmd) : ''}`
        : `could not start ${cmd}: ${e.message}`);
      resolve(127);
    };
    let child;
    try { child = legacy ? crossSpawn(shell, shellArgs, { cwd, stdio: 'inherit' }) : spawn(shell, shellArgs, { cwd, stdio: 'inherit' }); }
    catch (error) { fail(error); return; }
    child.on('error', fail);
    child.on('exit', code => resolve(code ?? 0));
  });
}

// ---- installing a missing agent ----

// Resolves the trimmed answer, or null when stdin closed without one (ctrl-D, a closed pipe).
// Resolving on 'close' rather than only in the callback keeps the promise from hanging on EOF.
export function askUser(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer = null;
    rl.question(question, a => { answer = String(a).trim().toLowerCase(); rl.close(); });
    rl.on('close', () => resolve(answer));
  });
}

// Offers to install the agent when it is missing. Resolves true if it is on PATH afterwards.
// The agent's own first-run login/setup then runs as usual when it launches.
export async function ensureAgent(cmd) {
  if (has(cmd)) return true;

  const pkg = INSTALL_PKG[cmd];
  if (!pkg) {
    console.error(`${cmd} was not found on PATH.`);
    return false;
  }
  // Without a terminal there is nobody to answer the prompt (e.g. piped output).
  if (!process.stdin.isTTY) {
    console.error(`${cmd} is not installed.${hint(cmd)}`);
    return false;
  }
  if (!has('npm')) {
    console.error(`${cmd} is not installed, and npm is not available to install it.`);
    console.error(`Install Node.js 20 or later, then run: npm install -g ${pkg}`);
    return false;
  }

  const answer = await askUser(`\n${cmd} is not installed. Install it now with "npm install -g ${pkg}"? (y/N) `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log(`Skipped. You can install it later: npm install -g ${pkg}`);
    return false;
  }

  console.log(`\nnpm install -g ${pkg}\n`);
  const [installer, installArgs] = IS_WIN
    ? windowsCommand('npm', ['install', '-g', pkg])
    : ['npm', ['install', '-g', pkg]];
  const r = spawnSync(installer, installArgs, { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`\nInstall failed${r.error ? `: ${r.error.message}` : ` (npm exited with ${r.status})`}.`);
    console.error(`If it was a permissions error, npm's global folder is not writable by you.`);
    console.error(`Check where it points with: npm prefix -g`);
    return false;
  }
  if (!has(cmd)) {
    console.error(`\n${pkg} installed, but "${cmd}" is still not on PATH.`);
    console.error(`npm's global bin folder is probably not in PATH. Find it with: npm prefix -g`);
    return false;
  }
  console.log(`\n${cmd} installed.\n`);
  return true;
}

// ---- new terminal tabs ----

const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) {
    // Keep the tool's own message: AppleScript errors are the only clue to a denied permission.
    const detail = String(r.stderr || '').trim().split('\n').find(Boolean);
    throw new Error(detail || `${cmd} exited with ${r.status}`);
  }
};

// macOS asks for Automation permission the first time; a denial comes back as -1743.
function macAutomationError(e, app) {
  const msg = e?.message || String(e);
  return /-1743|not authoriz/i.test(msg)
    ? `macOS blocked ccnav from controlling ${app}. Allow your terminal under System Settings → Privacy & Security → Automation, then try again.`
    : msg;
}

// Opens a new terminal tab (or window) in `cwd` running `cmd` with `args`. Throws if nothing worked.
export function openInNewTab(cmd, cwd, args, title = cmd) {
  if (IS_WIN) {
    const spec = Buffer.from(JSON.stringify({ cmd, cwd, args }), 'utf8').toString('base64');
    const helper = fileURLToPath(new URL('./windows-tab.mjs', import.meta.url));
    const [agentShell, agentArgs] = windowsCommand(process.execPath, [helper, spec], { keepOpen: true });
    const argv = ['-w', '0', 'new-tab', '--title', title.replace(/[\r\n;"]/g, ' ').slice(0, 40), '-d', cwd,
      agentShell, ...agentArgs];
    const [terminalShell, terminalArgs] = windowsCommand('wt.exe', argv);
    const r = spawnSync(terminalShell, terminalArgs, { stdio: 'ignore', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(r.error?.message || `wt.exe exited with ${r.status}`);
    return 'Windows Terminal tab';
  }

  const shellCmd = `cd ${shq(cwd)} && ${cmd} ${args.map(shq).join(' ')}`;
  const term = process.env.TERM_PROGRAM || '';

  if (term === 'WezTerm' && has('wezterm')) {
    run('wezterm', ['cli', 'spawn', '--cwd', cwd, '--', cmd, ...args]);
    return 'WezTerm tab';
  }
  if (process.env.KITTY_WINDOW_ID && has('kitty')) {
    run('kitty', ['@', 'launch', '--type=tab', '--cwd', cwd, cmd, ...args]);
    return 'kitty tab';
  }
  if (IS_MAC) {
    if (term === 'iTerm.app') {
      try {
        // A tab needs a window to live in: iTerm can be running with none open.
        run('osascript', ['-e', [
          'tell application "iTerm"',
          '  activate',
          '  if (count of windows) = 0 then',
          '    create window with default profile',
          '  else',
          '    tell current window to create tab with default profile',
          '  end if',
          `  tell current session of current window to write text ${osaString(shellCmd)}`,
          'end tell',
        ].join('\n')]);
      } catch (e) { throw new Error(macAutomationError(e, 'iTerm')); }
      return 'iTerm tab';
    }
    // Terminal.app (and anything else): a new Terminal window. Real tabs would need Accessibility permission.
    try {
      run('osascript', ['-e', `tell application "Terminal" to do script ${osaString(shellCmd)}`,
        '-e', 'tell application "Terminal" to activate']);
    } catch (e) { throw new Error(macAutomationError(e, 'Terminal')); }
    return 'Terminal window';
  }
  if (has('gnome-terminal')) {
    run('gnome-terminal', ['--tab', `--working-directory=${cwd}`, '--', cmd, ...args]);
    return 'GNOME Terminal tab';
  }
  if (has('konsole')) {
    run('konsole', ['--new-tab', '--workdir', cwd, '-e', cmd, ...args]);
    return 'Konsole tab';
  }
  throw new Error('no supported terminal found (Windows Terminal, iTerm2, Terminal.app, WezTerm, kitty, GNOME Terminal, Konsole)');
}

export function openFolder(dir) {
  const cmd = IS_WIN ? 'explorer.exe' : IS_MAC ? 'open' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function copyToClipboard(text) {
  const candidates = IS_WIN ? [['clip', []]]
    : IS_MAC ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, argv] of candidates) {
    const r = spawnSync(cmd, argv, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!r.error && r.status === 0) return;
  }
  throw new Error('no clipboard tool found');
}

// ---- shell integration: a wrapper function that cds into the directory ccnav reports ----

const BEGIN = '# >>> ccnav >>>';
const END = '# <<< ccnav <<<';

const POWERSHELL_FN = `
# Wraps the ccnav npm shim so this shell ends up in the chosen session's directory.
function ccnav {
    $shim = Join-Path $env:APPDATA 'npm\\ccnav.ps1'
    if (-not (Test-Path -LiteralPath $shim)) { Write-Warning 'ccnav is not installed on this machine'; return }
    $cwdFile = [IO.Path]::GetTempFileName()
    $env:CCNAV_CWD_FILE = $cwdFile
    try { & $shim @args }
    finally {
        Remove-Item Env:CCNAV_CWD_FILE -ErrorAction Ignore
        $dir = Get-Content -LiteralPath $cwdFile -Raw -ErrorAction Ignore
        Remove-Item -LiteralPath $cwdFile -ErrorAction Ignore
        if ($dir -and (Test-Path -LiteralPath $dir.Trim())) { Set-Location -LiteralPath $dir.Trim() }
    }
}
`;

// Works in both bash and zsh. `command` skips the function; the subshell check avoids finding it too.
const POSIX_FN = `
# Wraps the ccnav binary so this shell ends up in the chosen session's directory.
ccnav() {
  if ! (unset -f ccnav; command -v ccnav >/dev/null 2>&1); then
    echo "ccnav: not installed on this machine" >&2; return 1
  fi
  local f rc dir
  f=$(mktemp "\${TMPDIR:-/tmp}/ccnav.XXXXXX") || return 1
  CCNAV_CWD_FILE="$f" command ccnav "$@"
  rc=$?
  dir=$(cat "$f" 2>/dev/null); rm -f "$f"
  if [ -n "$dir" ] && [ -d "$dir" ]; then cd "$dir"; fi
  return $rc
}
`;

const FISH_FN = `
function ccnav --description 'Resume a Claude Code or Codex session in its directory'
    if not command -q ccnav
        echo "ccnav: not installed on this machine" >&2; return 1
    end
    set -l f (mktemp)
    env CCNAV_CWD_FILE=$f command ccnav $argv
    set -l rc $status
    set -l dir (cat $f 2>/dev/null); rm -f $f
    if test -n "$dir"; and test -d "$dir"; cd $dir; end
    return $rc
end
`;

function shellTarget() {
  if (IS_WIN) {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$PROFILE'], { encoding: 'utf8' });
    const file = r.stdout?.trim() || path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    return { shell: 'powershell', file, body: POWERSHELL_FN };
  }
  const shell = path.basename(process.env.SHELL || (IS_MAC ? 'zsh' : 'bash'));
  if (shell === 'fish') {
    return { shell, file: path.join(os.homedir(), '.config', 'fish', 'functions', 'ccnav.fish'), body: FISH_FN };
  }
  if (shell === 'zsh') {
    return { shell, file: path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc'), body: POSIX_FN };
  }
  // macOS login shells read .bash_profile; Linux interactive shells read .bashrc.
  return { shell: 'bash', file: path.join(os.homedir(), IS_MAC ? '.bash_profile' : '.bashrc'), body: POSIX_FN };
}

// Idempotent: replaces an existing ccnav block instead of appending a second one.
export function installShellFunction() {
  const { shell, file, body } = shellTarget();
  const block = `${BEGIN}${body}${END}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  const next = re.test(current)
    ? current.replace(re, () => block)
    : current.replace(/\s*$/, '') + (current ? '\n\n' : '') + block + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  const reload = shell === 'powershell' ? '. $PROFILE' : shell === 'fish' ? 'open a new fish shell' : `source ${file.replace(os.homedir(), '~')}`;
  return { shell, file, reload };
}
