import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama, requirePi } from '../deps.js';
import { ctxForModel, findFirstMatch, pickModel, scanModels } from '../models.js';
import { PI_PROVIDER_KEY, ensurePiModelsJson } from '../pi-config.js';
import { refuseIfPortTaken } from '../preflight.js';
import { launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import { pc } from '../ui.js';

export interface PiOpts {
  /** Stop any running server first (used by `switch`). */
  stopFirst?: boolean;
}

export async function pi(args: string[], opts: PiOpts = {}): Promise<void> {
  const cfg = loadConfig();
  requirePi();

  // First positional arg may be a model name pattern; the rest is forwarded to pi.
  let pattern: string | undefined;
  let forward: string[] = args;
  if (args[0] && !args[0].startsWith('-')) {
    pattern = args[0];
    forward = args.slice(1);
  }

  // ── Local mode: we manage llama-server ──────────────────────────────
  requireLlama(cfg);

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  const model = pattern
    ? findFirstMatch(models, pattern)
    : await pickModel(models, 'Pick a model for pi');

  if (!model) {
    if (pattern) p.log.error(`No model matching '${pattern}'`);
    process.exit(1);
  }

  let status = await serverStatus(cfg);

  // If `switch` was invoked, stop locca-managed server first.
  if (opts.stopFirst && status.running && status.source === 'pid') {
    await stopServer(cfg);
    await new Promise((r) => setTimeout(r, 500));
    status = await serverStatus(cfg);
  }

  if (status.running && status.source === 'attached') {
    // Something else (manual launch, another tool) is on our default port.
    // We don't know what model it's serving — use whatever it reports — but
    // we also can't switch its model. Tell the user what's happening.
    const servedModel = status.model ?? 'unknown';
    if (basename(model.path) !== servedModel) {
      p.log.warn(
        `Attached server is serving '${servedModel}', not '${model.name}'. Using attached server (can't switch model on a server locca doesn't manage).`,
      );
    } else {
      console.log(`Attached server already serving ${model.name}`);
    }
    await runPi(cfg, servedModel, `${status.url}/v1`, cfg.defaultCtx, forward);
    return;
  }

  if (status.running && status.source === 'pid') {
    if (status.model && basename(model.path) === status.model) {
      console.log(`Server already running with ${model.name}`);
    } else {
      console.log(`Switching model: ${status.model ?? '?'} -> ${model.name}`);
      await stopServer(cfg);
      await new Promise((r) => setTimeout(r, 500));
      status = { running: false };
    }
  }

  const port = cfg.defaultPort;
  const ctx = ctxForModel(model.name, cfg.vramBudgetMB);

  if (!status.running) {
    await refuseIfPortTaken(port);
    console.log(`Starting ${model.name} on port ${port} (ctx ${ctx})...`);
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
    const ready = await waitReady(port, 30);
    if (!ready) {
      p.log.error(
        `Server failed to start. Check ${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/locca-server.log`,
      );
      await stopServer(cfg);
      process.exit(1);
    }
    console.log('Server ready.');
  }

  await runPi(cfg, basename(model.path), `http://127.0.0.1:${port}/v1`, ctx, forward);
}

async function runPi(
  cfg: import('../types.js').Config,
  modelId: string,
  baseUrl: string,
  contextWindow: number,
  forward: string[],
): Promise<void> {
  // Pi 0.70+ requires custom OpenAI-compatible servers to be registered
  // via ~/.pi/agent/models.json (the older `--provider llamacpp` was
  // removed). We write/update the entry every time so the model id and
  // baseUrl always match whatever's actually running.
  ensurePiModelsJson(modelId, baseUrl, contextWindow);

  console.log(`Launching pi with ${modelId}...`);
  console.log();

  const skillArgs: string[] = [];
  if (cfg.piSkillDir) {
    try {
      if (existsSync(cfg.piSkillDir) && statSync(cfg.piSkillDir).isDirectory()) {
        skillArgs.push('--skill', cfg.piSkillDir);
      }
    } catch {
      // ignore
    }
  }

  const piArgs = ['--model', `${PI_PROVIDER_KEY}/${modelId}`];
  if (!cfg.piSkills) piArgs.push('--no-skills');
  if (!cfg.piExtensions) piArgs.push('--no-extensions');
  if (!cfg.piContextFiles) piArgs.push('--no-context-files');
  piArgs.push(...skillArgs, ...forward);

  const child = spawn('pi', piArgs, { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });

  void pc;
}
