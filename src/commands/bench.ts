import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { CONFIG_FILE, loadConfig } from '../config.js';
import { pickModel, scanModels } from '../models.js';
import { pc } from '../ui.js';
import { have } from '../util.js';

interface BenchRow {
  model_type?: string;
  model_filename?: string;
  model_size?: number;
  model_n_params?: number;
  n_threads?: number;
  n_gpu_layers?: number;
  backends?: string;
  n_prompt?: number;
  n_gen?: number;
  avg_ts?: number;
  stddev_ts?: number;
}

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
  spinner.start('Running llama-bench (~30–60s)...');

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(
      cfg.llamaBench,
      ['-m', model.path, '-ngl', '999', '-t', String(cfg.defaultThreads), '-o', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => resolve(code));
  });

  spinner.stop('Done');

  if (exitCode !== 0) {
    p.log.error(`llama-bench exited with code ${exitCode}`);
    if (stderr) console.log(stderr);
    return;
  }

  let rows: BenchRow[];
  try {
    rows = JSON.parse(stdout);
  } catch {
    // -o json may not be supported on very old llama-bench builds; just
    // dump whatever it printed.
    console.log(stdout);
    return;
  }

  renderBench(rows);
}

export function renderBench(rows: BenchRow[]): void {
  if (rows.length === 0) {
    p.log.warn('llama-bench returned no results.');
    return;
  }
  const head = rows[0]!;

  // Identify the prompt-processing and token-generation rows.
  // llama-bench encodes them as n_prompt > 0 / n_gen == 0 (pp) and the
  // reverse for tg.
  const pp = rows.find((r) => (r.n_prompt ?? 0) > 0 && (r.n_gen ?? 0) === 0);
  const tg = rows.find((r) => (r.n_gen ?? 0) > 0);

  const paramsB = head.model_n_params != null ? (head.model_n_params / 1e9).toFixed(2) : '?';
  const sizeGB = head.model_size != null ? (head.model_size / 1024 / 1024 / 1024).toFixed(2) : '?';
  const modelType = head.model_type ?? '(unknown model type)';
  const backend = head.backends ?? '?';
  const ngl = head.n_gpu_layers ?? '?';
  const threads = head.n_threads ?? '?';

  console.log();
  console.log(`  ${pc.magenta(pc.bold('Benchmark'))}`);
  console.log(`  ${pc.dim('─'.repeat(64))}`);
  console.log(`  Model      ${modelType}  ${pc.dim(`(${paramsB}B params · ${sizeGB} GiB)`)}`);
  console.log(`  Backend    ${backend}, ngl ${ngl}, ${threads} threads`);
  console.log();

  // Both rows render with identical column widths so the values line up.
  if (tg) renderRow('Generation', tg, pc.green, 'drives perceived speed');
  if (pp) renderRow('Prompt eval', pp, pc.cyan, 'parallel, batched');

  if (tg?.avg_ts && pp?.avg_ts) {
    const tgRate = tg.avg_ts;
    const ppRate = pp.avg_ts;
    console.log();
    console.log(`  ${pc.dim('Translates to:')}`);
    console.log(`    ${pc.dim('•')} 200-token reply        ${fmtSec(200 / tgRate)}`);
    console.log(`    ${pc.dim('•')} 2000-token reply       ${fmtSec(2000 / tgRate)}`);
    console.log(
      `    ${pc.dim('•')} 1000-token prompt eval ${fmtSec(1000 / ppRate)}  ${pc.dim('(time-to-first-token)')}`,
    );
  }
  console.log();
}

function renderRow(
  label: string,
  row: BenchRow,
  colour: (s: string) => string,
  hint: string,
): void {
  const tps = row.avg_ts ?? 0;
  const std = row.stddev_ts != null ? `±${row.stddev_ts.toFixed(2)}` : '';
  const wps = Math.round(tps / 1.3); // ~1.3 BPE tokens per English word
  console.log(
    `  ${pc.bold(label.padEnd(11))}  ${colour(`${tps.toFixed(1).padStart(7)} tok/s`)}  ${pc.dim(std.padEnd(7))}  ${pc.dim(`≈ ${String(wps).padStart(4)} words/sec    ${hint}`)}`,
  );
}

function fmtSec(s: number): string {
  if (s < 1) return `${(s * 1000).toFixed(0).padStart(3)} ms`;
  if (s < 60) return `${s.toFixed(1).padStart(5)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
