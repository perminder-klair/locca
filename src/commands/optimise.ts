import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { serverArgsForModel } from '../catalog.js';
import { loadConfig } from '../config.js';
import { requireLlama, requirePi } from '../deps.js';
import { type DoctorReport, runDoctor, summariseForPrompt } from '../doctor.js';
import { ctxForModel, pickModel, scanModels } from '../models.js';
import { PI_PROVIDER_KEY, ensurePiModelsJson } from '../pi-config.js';
import { refuseIfPortTaken } from '../preflight.js';
import { launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import { buildStatsLine } from '../sys-stats.js';
import type { Config } from '../types.js';
import { header, pc } from '../ui.js';

export async function optimise(): Promise<void> {
  const cfg = loadConfig();
  requirePi();

  header('locca  ·  optimise');

  p.note(
    `${pc.yellow('Advice quality is bounded by your local model.')}\nA 2-4B model will hallucinate flags. Run on a ≥7B instruct model for\nusable output. Verify any suggested change against llama.cpp docs\nbefore applying.`,
    'Experimental',
  );

  const spinner = p.spinner();
  spinner.start('Gathering deployment state...');
  const report = await runDoctor(cfg);
  spinner.stop('Deployment state gathered.');

  printBriefFindings(report);

  // Make sure something is serving — pi can't analyse without a model.
  let serverInfo: ServerInfo;
  try {
    serverInfo = await ensureServer(cfg, report);
  } catch (e) {
    p.log.error((e as Error).message);
    process.exit(1);
  }

  console.log();
  p.log.info(
    `Asking pi to review (model: ${pc.cyan(serverInfo.modelId)}, ctx: ${serverInfo.ctx.toLocaleString()})`,
  );
  console.log();

  const prompt = summariseForPrompt(report);
  await runPiPrint(serverInfo, prompt);
}

interface ServerInfo {
  modelId: string;
  baseUrl: string;
  ctx: number;
  /** `true` if we just spawned a fresh server here. */
  spawnedHere: boolean;
}

async function ensureServer(cfg: Config, report: DoctorReport): Promise<ServerInfo> {
  requireLlama(cfg);

  // Always let the user pick — a 2-4B model can't sensibly review a 70B
  // deployment, so picking is meaningful even if a server is already up.
  // Smaller (≤9 GiB) models sit at the top so the default highlight stays
  // sensible.
  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    throw new Error(
      `No models in ${cfg.modelsDir}. Run \`locca download\` or \`locca search\` to fetch one.`,
    );
  }
  const ordered = [
    ...models.filter((m) => m.sizeGB <= 9),
    ...models.filter((m) => m.sizeGB > 9),
  ];
  const model = await pickModel(ordered, 'Pick a model to run optimise against');
  if (!model) throw new Error('No model selected.');

  // If something's already serving the same model, reuse it.
  if (report.status.running && report.status.model === basename(model.path)) {
    return {
      modelId: report.status.model,
      baseUrl: `${report.status.url}/v1`,
      ctx: report.liveCtx ?? cfg.defaultCtx,
      spawnedHere: false,
    };
  }

  // Different model running. If it's locca-managed, swap. If it's attached
  // (started by hand), we can't switch — bail with a clear message.
  if (report.status.running) {
    if (report.status.source === 'attached') {
      throw new Error(
        `Attached server on :${cfg.defaultPort} is serving '${report.status.model ?? '?'}', not '${model.name}'. Stop it manually before running optimise on a different model.`,
      );
    }
    console.log(
      `  Switching server: ${pc.dim(report.status.model ?? '?')} -> ${pc.cyan(model.name)}`,
    );
    await stopServer(cfg);
    await new Promise((r) => setTimeout(r, 500));
  }

  const port = cfg.defaultPort;
  const ctx = ctxForModel(model.name, cfg.vramBudgetMB);

  await refuseIfPortTaken(port);
  console.log(`  Starting ${pc.cyan(model.name)} on port ${port} (ctx ${ctx})...`);
  launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads: cfg.defaultThreads,
    host: '127.0.0.1',
    extraArgs: serverArgsForModel(basename(model.path)),
    noMmap: cfg.noMmap,
    detached: true,
  });
  const ready = await waitReady(port, 60);
  if (!ready) {
    throw new Error(
      `Server failed to start. Check ${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/locca-server.log`,
    );
  }
  // Confirm the loaded model id from /v1/models — the file basename is what
  // llama-server reports back, and it's what pi must reference.
  await new Promise((r) => setTimeout(r, 250));
  const fresh = await serverStatus(cfg);
  const reportedId = fresh.running ? fresh.model : undefined;
  return {
    modelId: reportedId ?? basename(model.path),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ctx,
    spawnedHere: true,
  };
}

async function runPiPrint(info: ServerInfo, prompt: string): Promise<void> {
  // Point pi at the live server. ensurePiModelsJson rewrites the `locca`
  // provider entry in ~/.pi/agent/models.json — same mechanism as `locca pi`.
  ensurePiModelsJson(info.modelId, info.baseUrl, info.ctx);

  const args = [
    '--model',
    `${PI_PROVIDER_KEY}/${info.modelId}`,
    '--print',
    '--no-tools',
    '--no-skills',
    '--no-extensions',
    '--no-context-files',
    '--no-session',
  ];

  // Pipe stdout so we can hold a spinner while pi is doing its initial
  // prompt eval (10–60s on local models) and only release the terminal once
  // pi actually starts emitting tokens. stderr stays inherited — pi prints
  // very little there in --print mode.
  const child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  // Pi can crash mid-stream (e.g. llama-server connection drops) — its
  // own output-guard then EPIPEs and dumps a stack trace. Swallow stream
  // errors here so they surface as a clean "Pi exited with code N" instead
  // of a node stack landing in the middle of a later command's output.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();

  const spinner = p.spinner();
  let firstChunk = true;
  let receivedAnyOutput = false;
  const startedAt = Date.now();
  const PROMPT = 'Pi is thinking (prompt eval can take 10–60s on local models)…';
  spinner.start(PROMPT);
  const tick = setInterval(() => {
    if (firstChunk) spinner.message(buildStatsLine(PROMPT, startedAt));
  }, 1000);

  child.stdout.on('data', (chunk: Buffer) => {
    if (firstChunk) {
      clearInterval(tick);
      spinner.stop('Pi:');
      firstChunk = false;
    }
    receivedAnyOutput = true;
    process.stdout.write(chunk);
  });

  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      clearInterval(tick);
      const failed = (code ?? 0) !== 0;
      if (firstChunk) {
        spinner.stop(
          failed
            ? `Pi exited with code ${code} (no output).`
            : receivedAnyOutput
              ? 'Pi finished.'
              : 'Pi exited without output.',
        );
      } else {
        // Ensure trailing newline so the menu re-render isn't glued to pi's
        // last token.
        process.stdout.write('\n');
        if (failed) p.log.warn(`Pi exited with code ${code} mid-output.`);
      }
      // Don't propagate pi's exit code to the locca process — optimise is
      // one menu action among many; a pi crash here shouldn't make `locca`
      // itself exit non-zero when the user later quits the menu.
      resolve();
    });
  });
}

function printBriefFindings(report: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('Quick check'))}`);
  if (report.findings.length === 0) {
    console.log(`    ${pc.green('✓ nothing flagged by heuristics')}`);
  } else {
    for (const f of report.findings) {
      const icon =
        f.severity === 'error'
          ? pc.red('✗')
          : f.severity === 'warn'
            ? pc.yellow('!')
            : pc.cyan('i');
      console.log(`    ${icon} ${pc.bold(`[${f.section}]`)} ${f.title}`);
    }
  }
}
