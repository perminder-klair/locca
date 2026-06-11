import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { logFile } from '../server.js';
import { note, pc } from '../ui.js';

const TAIL_LINES = 100;

export async function logs(args: string[] = []): Promise<void> {
  // `locca logs embed` tails the embedding server's log; default is the chat
  // server's log.
  const role = args[0] === 'embed' ? 'embed' : 'chat';
  const target = logFile(role);
  const label = role === 'embed' ? 'embedding ' : '';

  if (!existsSync(target) || statSync(target).size === 0) {
    note(
      `No ${label}log at ${target} (only detached locca-started servers write here).`,
    );
    return;
  }
  console.log(pc.magenta(`Last ${TAIL_LINES} lines of ${target}`));
  console.log();
  spawnSync('tail', ['-n', String(TAIL_LINES), target], { stdio: 'inherit' });
  console.log();
  note(`Run \`tail -f ${target}\` in a separate terminal to follow live.`);
}
