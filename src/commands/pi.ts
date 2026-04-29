import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama, requirePi } from '../deps.js';
import { ctxForModel, findFirstMatch, pickModel, scanModels } from '../models.js';
import {
  launchServer,
  serverStatus,
  stopServer,
  waitReady,
} from '../server.js';
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

  // ── External-server mode (cfg.serverUrl set) ────────────────────────
  // Skip spawning entirely. Just point pi at the configured URL using
  // whatever model the server reports.
  if (cfg.serverUrl) {
    if (pattern) {
      p.log.warn(
        `Ignoring model pattern '${pattern}' — external server is serving its own model.`,
      );
    }
    const status = await serverStatus(cfg);
    if (!status.running) {
      p.log.error(
        `Configured serverUrl (${cfg.serverUrl}) is not responding. Start it or run \`pi-llm setup\` to clear serverUrl.`,
      );
      process.exit(1);
    }
    const modelId = status.model ?? 'local';
    console.log(`Using external server: ${status.url}  (model: ${modelId})`);
    await runPi(cfg.piSkillDir, modelId, status.url, forward);
    return;
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

  // If `switch` was invoked, stop pi-llm-managed server first.
  if (opts.stopFirst && status.running && status.source === 'pid') {
    await stopServer(cfg);
    await new Promise((r) => setTimeout(r, 500));
    status = await serverStatus(cfg);
  }

  if (status.running && status.source === 'attached') {
    // Something else (docker, manual launch) is on our default port.
    // We don't know what model it's serving — use whatever it reports — but
    // we also can't switch its model. Tell the user what's happening.
    const servedModel = status.model ?? 'unknown';
    if (basename(model.path) !== servedModel) {
      p.log.warn(
        `Attached server is serving '${servedModel}', not '${model.name}'. Using attached server (can't switch model on a server pi-llm doesn't manage).`,
      );
    } else {
      console.log(`Attached server already serving ${model.name}`);
    }
    await runPi(cfg.piSkillDir, servedModel, status.url, forward);
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
  const ctx = ctxForModel(model.name);

  if (!status.running) {
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
        `Server failed to start. Check ${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/pi-llm-server.log`,
      );
      await stopServer(cfg);
      process.exit(1);
    }
    console.log('Server ready.');
  }

  await runPi(cfg.piSkillDir, basename(model.path), `http://127.0.0.1:${port}`, forward);
}

async function runPi(
  piSkillDir: string | undefined,
  modelId: string,
  baseUrl: string,
  forward: string[],
): Promise<void> {
  console.log(`Launching pi with ${modelId}...`);
  console.log();

  const skillArgs: string[] = [];
  if (piSkillDir) {
    try {
      if (existsSync(piSkillDir) && statSync(piSkillDir).isDirectory()) {
        skillArgs.push('--skill', piSkillDir);
      }
    } catch {
      // ignore
    }
  }

  // pi takes --base-url for non-default servers; it always reads the URL from
  // the provider config. For now we rely on `pi --provider llamacpp` and
  // assume the user keeps pi pointed at the same port pi-llm uses, which is
  // the same port that's running.
  const piArgs = [
    '--provider',
    'llamacpp',
    '--model',
    modelId,
    '--no-skills',
    '--no-extensions',
    ...skillArgs,
    ...forward,
  ];

  const child = spawn('pi', piArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Some pi versions read base URL from this env var; harmless if ignored.
      LLAMACPP_BASE_URL: baseUrl,
    },
  });
  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });

  void pc;
}
