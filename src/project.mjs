// `ccnav new`: the saved projects folder new projects are made in, and the checks on a new project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CCNAV_HOME } from './usage.mjs';

export const CONFIG_FILE = path.join(CCNAV_HOME, 'config.json');
export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), 'Projects');

// A missing file is an empty config; an unreadable one throws rather than being overwritten.
export function loadConfig() {
  let text;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try { return JSON.parse(text) || {}; } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON; fix or delete it`);
  }
}

export function saveConfig(changes) {
  const next = { ...loadConfig(), ...changes };
  fs.mkdirSync(CCNAV_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// A folder as typed at a prompt: quotes dropped, `~` is the home directory, relative to cwd.
export function expandDir(text, cwd = process.cwd()) {
  const s = String(text).trim().replace(/^(["'])(.*)\1$/, '$2');
  const home = s === '~' || /^~[\\/]/.test(s) ? path.join(os.homedir(), s.slice(1)) : s;
  return path.resolve(cwd, home);
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// One folder name that is valid on Windows, macOS and Linux alike. Null when it is fine.
export function projectNameProblem(name) {
  if (!name) return 'a project name is needed';
  if (name === '.' || name === '..') return `"${name}" is not a folder name`;
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'a project name cannot contain / \\ : * ? " < > |';
  if (/^\s|[\s.]$/.test(name)) return 'a project name cannot start with a space or end with a space or dot';
  if (RESERVED.test(name)) return `"${name}" is a reserved name on Windows`;
  return null;
}

// Null on success, otherwise why it did not happen.
export function gitInit(dir) {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') return 'git is not installed';
  if (r.status !== 0) return (r.stderr || r.error?.message || 'git init failed').trim();
  return null;
}
