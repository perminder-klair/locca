import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { readGgufHeader } from '../gguf.js';
import { pickModel, scanModels } from '../models.js';
import { pc } from '../ui.js';
import { formatGB, formatMB } from '../util.js';

export async function info(): Promise<void> {
  const cfg = loadConfig();
  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.message('No models found.');
    return;
  }

  const model = await pickModel(models, 'Pick a model');
  if (!model) return;

  console.log();
  console.log(`  ${pc.magenta(pc.bold(model.name))}`);
  console.log();
  console.log(`  Path:  ${model.path}`);
  console.log(`  Size:  ${formatGB(model.sizeBytes)} GB`);

  const header = readGgufHeader(model.path);
  if (header) {
    console.log(`  GGUF:  v${header.version}  (${header.nTensors} tensors, ${header.nKv} metadata)`);
  }

  if (model.mmprojPath) {
    try {
      const mmSize = statSync(model.mmprojPath).size;
      console.log(`  Vision: ${model.mmprojPath.split('/').pop()} (${formatMB(mmSize)} MB)`);
    } catch {
      console.log(`  Vision: ${model.mmprojPath.split('/').pop()}`);
    }
  } else {
    console.log(`  Vision: no`);
  }

  console.log();
  console.log(`  Files:`);
  for (const entry of readdirSync(model.dir)) {
    try {
      const s = statSync(join(model.dir, entry));
      const size = s.isFile() ? `${formatGB(s.size).padStart(6)} GB` : '<dir>';
      console.log(`    ${entry.padEnd(60)}  ${size}`);
    } catch {
      // ignore
    }
  }
}
