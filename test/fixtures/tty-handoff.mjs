// Runs in a real console: shows and closes a real Ink picker, then launches a probe "agent" the way
// ccnav does, and records whether this process was still reading the terminal while the agent ran.
// usage: node tty-handoff.mjs <platform.mjs to test> <result.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { useEffect } from 'react';
import { Text, render, useApp, useInput } from 'ink';

const [platformFile, outFile] = process.argv.slice(2);
const result = {};
const save = () => fs.writeFileSync(outFile, JSON.stringify(result));
const guard = setTimeout(() => { result.error = 'timed out'; save(); process.exit(2); }, 15000);
const state = () => ({ isTTY: process.stdin.isTTY, reading: process.stdin._handle?.reading,
  destroyed: process.stdin.destroyed });

try {
  const { launchAgent } = await import(pathToFileURL(path.resolve(platformFile)).href);

  // The picker reads keys through useInput, which turns raw mode on; it closes itself shortly after.
  function Picker() {
    const { exit } = useApp();
    useInput(() => {});
    useEffect(() => { const t = setTimeout(exit, 200); return () => clearTimeout(t); }, [exit]);
    return React.createElement(Text, null, 'picker');
  }
  const app = render(React.createElement(Picker), { exitOnCtrlC: false, patchConsole: false });
  await app.waitUntilExit();
  result.afterInk = state();

  const probe = fileURLToPath(new URL('./tty-probe.cjs', import.meta.url));
  const probeOut = `${outFile}.probe`;
  result.exitCode = await launchAgent(process.execPath, process.cwd(), [probe, probeOut]);
  result.afterLaunch = state();
  result.probe = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
} catch (error) {
  result.error = error.stack || String(error);
}
clearTimeout(guard);
save();
process.exit(0);
