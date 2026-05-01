import * as p from '@clack/prompts';
import { CONFIG_FILE } from './config.js';
import { describePortOccupant, isPortInUse } from './server.js';

/**
 * Refuse to spawn llama-server if `port` is already taken by a non-llama
 * service. Identifies the squatter (some web UI, Jupyter, etc.) when
 * possible so the error tells you what's actually conflicting.
 *
 * `serverStatus()` already attaches to anything serving `/health`, so this
 * runs *after* that and only catches the "occupied but not us" case.
 */
export async function refuseIfPortTaken(port: number): Promise<void> {
  if (!(await isPortInUse(port))) return;
  const who = await describePortOccupant(port);
  const tail = who ? ` (looks like: ${who})` : '';
  p.log.error(
    `Port ${port} is already in use${tail}, and it's not a llama.cpp server.

Either stop whatever's on port ${port}, or change \`defaultPort\` in
${CONFIG_FILE} to a free port (e.g. 8081, 18080) and try again.`,
  );
  process.exit(1);
}
