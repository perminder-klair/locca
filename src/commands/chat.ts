import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { pickModel, scanModels } from '../models.js';
import { pc } from '../ui.js';

export async function chat(): Promise<void> {
  const cfg = loadConfig();
  requireLlama(cfg);

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  const model = await pickModel(models, 'Pick a model to chat with');
  if (!model) return;

  console.log();
  console.log(pc.magenta(`  Starting chat with ${model.name}...`));
  console.log();

  const args = [
    '-m',
    model.path,
    '-ngl',
    '999',
    '-t',
    String(cfg.defaultThreads),
    '--flash-attn',
    'on',
    '--cache-type-k',
    'q8_0',
    '--cache-type-v',
    'q8_0',
    '--batch-size',
    '1024',
    '--jinja',
    '--ctx-size',
    String(cfg.defaultCtx),
    '-cnv',
  ];
  if (model.mmprojPath) args.unshift('--mmproj', model.mmprojPath);

  const child = spawn(cfg.llamaCli, args, { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
