// The stand-in agent for tty-handoff.mjs: reports whether it got a terminal it can put in raw mode.
const fs = require('node:fs');
const out = { isTTY: Boolean(process.stdin.isTTY) };
try {
  process.stdin.setRawMode(true);
  out.raw = process.stdin.isRaw;
  process.stdin.setRawMode(false);
} catch (error) { out.error = error.message; }
fs.writeFileSync(process.argv[2], JSON.stringify(out));
process.exit(0);
