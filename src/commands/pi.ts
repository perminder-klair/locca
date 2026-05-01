import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama, requirePi } from '../deps.js';
import { ctxForModel, findFirstMatch, pickModel, scanModels } from '../models.js';
import { PI_PROVIDER_KEY, ensurePiModelsJson } from '../pi-config.js';
import { ensureStripSkillsExtension } from '../pi-extension.js';
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

  const piArgs = ['--model', `${PI_PROVIDER_KEY}/${modelId}`];
  // piSkills tri-state: 'off' disables entirely; 'lazy' loads skills but
  // strips their descriptions from the system prompt via a bundled extension
  // (slash commands still resolve); 'on' is pi's default.
  const skillMode = cfg.piSkills ?? 'lazy';
  if (skillMode === 'off') piArgs.push('--no-skills');
  if (!cfg.piExtensions) piArgs.push('--no-extensions');
  if (!cfg.piContextFiles) piArgs.push('--no-context-files');

  if (skillMode === 'lazy' && cfg.piExtensions) {
    // Lazy mode requires the extension host to be enabled — it's the only
    // mechanism we have to reach into the system prompt. If extensions are
    // off, fall back to 'on' behaviour and warn loudly.
    piArgs.push('--extension', ensureStripSkillsExtension());
  } else if (skillMode === 'lazy' && !cfg.piExtensions) {
    p.log.warn(
      "piSkills='lazy' requires piExtensions=true — skills will load normally. Run `locca config` to enable extensions.",
    );
  }

  piArgs.push(...forward);

  const child = spawn('pi', piArgs, { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });

  void pc;
}
