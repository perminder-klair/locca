import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { LOGFILE } from '../server.js';
import { note, pc } from '../ui.js';

const TAIL_LINES = 100;

export async function logs(): Promise<void> {
  if (!existsSync(LOGFILE) || statSync(LOGFILE).size === 0) {
    note(
      `No log at ${LOGFILE} (only servers started via 'locca pi' write here).`,
    );
    return;
  }
  console.log(pc.magenta(`Last ${TAIL_LINES} lines of ${LOGFILE}`));
  console.log();
  spawnSync('tail', ['-n', String(TAIL_LINES), LOGFILE], { stdio: 'inherit' });
  console.log();
  note(`Run \`tail -f ${LOGFILE}\` in a separate terminal to follow live.`);
}
