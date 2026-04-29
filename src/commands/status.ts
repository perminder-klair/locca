import { loadConfig } from '../config.js';
import { modelLine, scanModels } from '../models.js';
import { serverStatus } from '../server.js';
import { header, pc } from '../ui.js';

export async function renderServerLine(): Promise<void> {
  const cfg = loadConfig();
  const s = await serverStatus(cfg);
  if (!s.running) {
    console.log(pc.dim('  ○ No server running'));
    return;
  }
  const tag =
    s.source === 'pid'
      ? `pid ${s.pid}`
      : s.source === 'external'
        ? 'external'
        : 'attached';
  const bits: string[] = [];
  if (s.model) bits.push(s.model);
  bits.push(s.url);
  bits.push(tag);
  console.log(pc.green(`  ● Running: ${bits.join(', ')}`));
}

export async function status(): Promise<void> {
  const cfg = loadConfig();
  header();
  await renderServerLine();
  console.log();

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    console.log(`  No models found in ${cfg.modelsDir}.`);
    return;
  }

  console.log(`  ${pc.magenta(pc.bold(`Models (${models.length})`))}`);
  console.log();
  for (const m of models) {
    console.log(`  ${modelLine(m)}`);
  }
}
