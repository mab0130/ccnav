// Started in a new Windows Terminal tab. The payload is data, so neither shell
// interprets session IDs or forwarded arguments as command source.
import { launchAgent } from './platform.mjs';

try {
  const { cmd, cwd, args } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  process.exit(await launchAgent(cmd, cwd, args));
} catch (error) {
  console.error(`ccnav: could not start agent in new tab: ${error.message}`);
  process.exit(127);
}
