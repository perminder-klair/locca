import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { stopServer } from '../server.js';

export async function stop(): Promise<void> {
  const cfg = loadConfig();
  const r = await stopServer(cfg);
  if (r.stopped) {
    p.log.success(`Server stopped (pid ${r.pid})`);
  } else {
    p.log.message(r.reason);
  }
}
