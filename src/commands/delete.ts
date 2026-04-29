import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { pickModel, scanModels } from '../models.js';
import { exitIfCancelled, pc } from '../ui.js';
import { formatGB } from '../util.js';

export async function del(): Promise<void> {
  const cfg = loadConfig();
  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.message('No models to delete.');
    return;
  }

  const model = await pickModel(models, 'Select model to delete');
  if (!model) return;

  console.log();
  console.log(`  Directory: ${model.dir}`);
  for (const entry of readdirSync(model.dir)) {
    try {
      const full = join(model.dir, entry);
      const s = statSync(full);
      const size = s.isFile() ? `${formatGB(s.size)} GB` : '<dir>';
      console.log(`    ${entry.padEnd(60)}  ${size}`);
    } catch {
      // ignore
    }
  }
  console.log();

  const yes = await p.confirm({
    message: `Delete ${model.name} and its directory?`,
    initialValue: false,
  });
  exitIfCancelled(yes);
  if (!yes) {
    p.log.message('Cancelled.');
    return;
  }
  rmSync(model.dir, { recursive: true, force: true });
  console.log(pc.green(`  Deleted: ${model.name}`));
}
