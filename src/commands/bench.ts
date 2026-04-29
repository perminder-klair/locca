import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { CONFIG_FILE, loadConfig } from '../config.js';
import { pickModel, scanModels } from '../models.js';
import { pc } from '../ui.js';
import { have } from '../util.js';

export async function bench(): Promise<void> {
  const cfg = loadConfig();
  if (!have(cfg.llamaBench)) {
    p.log.error(
      `'${cfg.llamaBench}' not found. Set llamaBench in ${CONFIG_FILE} to an absolute path, or install llama.cpp's bench tool.`,
    );
    process.exit(1);
  }

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  const model = await pickModel(models, 'Pick a model to benchmark');
  if (!model) return;

  console.log();
  console.log(pc.magenta(`Benchmarking ${model.name}...`));
  console.log();

  const spinner = p.spinner();
  spinner.start('Running llama-bench...');

  let stdout = '';
  await new Promise<void>((resolve) => {
    const child = spawn(
      cfg.llamaBench,
      ['-m', model.path, '-ngl', '999', '-t', String(cfg.defaultThreads)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('exit', () => resolve());
  });

  spinner.stop('Done');

  // Filter to the table lines (start with `|`).
  const table = stdout
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .join('\n');
  console.log();
  console.log(table);
}
