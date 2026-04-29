import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { LOGFILE } from '../server.js';
import { note, pc } from '../ui.js';

export async function logs(): Promise<void> {
  if (!existsSync(LOGFILE) || statSync(LOGFILE).size === 0) {
    note(
      `No log at ${LOGFILE} (only servers started via 'pi-llm pi' write here).`,
    );
    return;
  }
  console.log(pc.magenta(`Tailing ${LOGFILE}  (Ctrl-C to stop)`));
  console.log();
  const child = spawn('tail', ['-n', '50', '-f', LOGFILE], { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
}
