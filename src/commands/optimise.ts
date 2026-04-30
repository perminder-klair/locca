import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama, requirePi } from '../deps.js';
import { type DoctorReport, runDoctor, summariseForPrompt } from '../doctor.js';
import { ctxForModel, scanModels } from '../models.js';
import { PI_PROVIDER_KEY, ensurePiModelsJson } from '../pi-config.js';
import { refuseIfPortTaken } from '../preflight.js';
import { launchServer, serverStatus, waitReady } from '../server.js';
import type { Config } from '../types.js';
import { header, pc } from '../ui.js';

export async function optimise(): Promise<void> {
  const cfg = loadConfig();
  requirePi();

  header('locca  ·  optimise');

  console.log(`  ${pc.yellow(pc.bold('Experimental'))}  ${pc.dim('— advice quality is bounded by your local model.')}`);
  console.log(`  ${pc.dim('A 2-4B model will hallucinate flags. Run on a ≥7B instruct model for usable output.')}`);
  console.log(`  ${pc.dim('Verify any suggested change against llama.cpp docs before applying.')}`);
  console.log();

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
  // External — already validated by doctor; use as-is.
  if (cfg.serverUrl && report.status.running && report.status.source === 'external') {
    const modelId = report.status.model ?? 'local';
    return {
      modelId,
      baseUrl: `${report.status.url}/v1`,
      ctx: report.liveCtx ?? cfg.defaultCtx,
      spawnedHere: false,
    };
  }
  if (cfg.serverUrl && !report.status.running) {
    throw new Error(
      `Configured serverUrl (${cfg.serverUrl}) is not responding. Start it, or clear serverUrl via \`locca setup\`.`,
    );
  }

  // Local mode.
  requireLlama(cfg);

  if (report.status.running) {
    // Reuse whatever's running (pid or attached). pi will talk to the same
    // server locca knows about; no model swap.
    const modelId = report.status.model ?? 'local';
    return {
      modelId,
      baseUrl: `${report.status.url}/v1`,
      ctx: report.liveCtx ?? cfg.defaultCtx,
      spawnedHere: false,
    };
  }

  // Nothing running — start the first available model.
  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    throw new Error(
      `No models in ${cfg.modelsDir}. Run \`locca download\` or \`locca search\` to fetch one.`,
    );
  }
  // Prefer the first model under ~9 GiB so we don't accidentally cold-start a
  // huge quant just to ask it about itself. Falls back to plain first if all
  // models are large.
  const small = models.find((m) => m.sizeGB <= 9);
  const model = small ?? models[0]!;
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
  child.stdin.write(prompt);
  child.stdin.end();

  const spinner = p.spinner();
  let firstChunk = true;
  let receivedAnyOutput = false;
  spinner.start('Pi is thinking (prompt eval can take 10–60s on local models)...');

  child.stdout.on('data', (chunk: Buffer) => {
    if (firstChunk) {
      spinner.stop('Pi:');
      firstChunk = false;
    }
    receivedAnyOutput = true;
    process.stdout.write(chunk);
  });

  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      if (firstChunk) {
        spinner.stop(receivedAnyOutput ? 'Pi finished.' : 'Pi exited without output.');
      } else {
        // Ensure trailing newline so the menu re-render isn't glued to pi's
        // last token.
        process.stdout.write('\n');
      }
      process.exitCode = code ?? 0;
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
