import type { ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { isEmbeddingModelName, mtpArgsForModel, serverArgsForModel } from '../catalog.js';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { findFirstMatch, pickModel, scanModels } from '../models.js';
import { refuseIfPortTaken } from '../preflight.js';
import { PIDFILE, launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import type { Config, Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';
import { api } from './api.js';
import { startEmbeddingSidecar } from './embed.js';

// Parsed `locca serve` invocation. A positional pattern (or `--yes`) switches
// serve into non-interactive mode — no Clack prompts, defaults filled from
// config, suitable for scripts / CI / a parent process managing locca.
interface ServeArgs {
  pattern?: string;
  port?: number;
  ctx?: number;
  threads?: number;
  yes: boolean;
  // Foreground: locca supervises llama-server in the foreground instead of
  // detaching — logs stream to stdout, SIGTERM/Ctrl-C stops it cleanly, and
  // locca exits with the server. The right shape for a container's PID 1.
  foreground: boolean;
}

function parseServeArgs(rest: string[]): ServeArgs {
  const out: ServeArgs = { yes: false, foreground: false };
  const num = (s: string | undefined): number | undefined => {
    const n = parseInt(s ?? '', 10);
    return Number.isFinite(n) ? n : undefined;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--foreground' || a === '-f') out.foreground = true;
    else if (a === '--port') out.port = num(rest[++i]);
    else if (a.startsWith('--port=')) out.port = num(a.slice('--port='.length));
    else if (a === '--ctx') out.ctx = num(rest[++i]);
    else if (a.startsWith('--ctx=')) out.ctx = num(a.slice('--ctx='.length));
    else if (a === '--threads') out.threads = num(rest[++i]);
    else if (a.startsWith('--threads=')) out.threads = num(a.slice('--threads='.length));
    else if (!a.startsWith('-') && out.pattern === undefined) out.pattern = a;
  }
  return out;
}

export async function serve(rest: string[] = []): Promise<void> {
  const cfg = loadConfig();
  const args = parseServeArgs(rest);
  // A pattern or `--yes` means "don't prompt me" — used by scripts and by a
  // parent process that wants to bring a specific model up unattended. No TTY
  // (a container, a pipe, CI) is treated the same way: we can't prompt, so we
  // resolve from the pattern / sole chat model instead of hanging on a picker.
  const nonInteractive = args.pattern !== undefined || args.yes || !process.stdin.isTTY;

  // Check who's on the port before requiring llama-server — we may bail
  // with a more informative error.
  const status = await serverStatus(cfg);
  if (status.running) {
    if (status.source === 'attached') {
      p.log.error(
        `Something is already responding on port ${status.port} (${status.url}) — locca did not start it. Stop it via whatever started it before running \`locca serve\`.`,
      );
      process.exit(1);
    }
    // pid source: locca started it, so just swap — no need to interrogate.
    p.log.info(`Stopping current server (pid ${status.pid}) to start a new one...`);
    await stopServer(cfg);
    await new Promise((r) => setTimeout(r, 500));
  }

  requireLlama(cfg);

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  // Embedding models can't serve chat (they'd hit the "Pooling type 'none'"
  // wall). Keep them out of the chat picker and point users at `locca embed`.
  const chatModels = models.filter((m) => !isEmbeddingModelName(m.name));
  if (chatModels.length === 0) {
    p.log.error(
      `Only embedding models found in ${cfg.modelsDir}. Serve those with \`locca embed\`, or download a chat model with \`locca download\`.`,
    );
    process.exit(1);
  }

  const model = nonInteractive
    ? resolveModelNonInteractive(args, models, chatModels)
    : await pickModel(chatModels, 'Pick a model to serve');
  if (!model) return;

  const { port, ctx, threads } = nonInteractive
    ? {
        port: args.port ?? cfg.defaultPort,
        ctx: args.ctx ?? cfg.defaultCtx,
        threads: args.threads ?? cfg.defaultThreads,
      }
    : await promptSettings(cfg);

  await refuseIfPortTaken(port);
  await launchModel(cfg, model, { port, ctx, threads, foreground: args.foreground });
}

// Resolve the model in non-interactive mode. A pattern fuzzy-matches the full
// model list the same way `locca pi <pattern>` does; with no pattern (`--yes`
// alone) we serve the sole chat model if there's exactly one, else we refuse
// rather than guess. Exits the process on any unresolvable case.
function resolveModelNonInteractive(args: ServeArgs, models: Model[], chatModels: Model[]): Model {
  if (args.pattern !== undefined) {
    const m = findFirstMatch(models, args.pattern);
    if (!m) {
      p.log.error(`No model matching '${args.pattern}' in the models dir.`);
      p.log.info(`Available: ${chatModels.map((c) => c.name).join(', ')}`);
      process.exit(1);
    }
    if (isEmbeddingModelName(m.name)) {
      p.log.error(`'${m.name}' is an embedding model — serve it with \`locca embed\`.`);
      process.exit(1);
    }
    return m;
  }
  // `--yes` with no pattern: only unambiguous when there's a single chat model.
  if (chatModels.length === 1) return chatModels[0];
  p.log.error('Multiple chat models found — pass a model pattern, e.g. `locca serve qwen --yes`.');
  p.log.info(`Available: ${chatModels.map((c) => c.name).join(', ')}`);
  process.exit(1);
}

// The interactive "Default vs Custom" settings prompt. Unchanged behaviour;
// extracted so the non-interactive path can skip it cleanly.
async function promptSettings(
  cfg: Config,
): Promise<{ port: number; ctx: number; threads: number }> {
  const choice = await p.select({
    message: 'Settings',
    options: [
      { value: 'default', label: `Default (port ${cfg.defaultPort}, ctx ${cfg.defaultCtx})` },
      { value: 'custom', label: 'Custom' },
    ],
  });
  exitIfCancelled(choice);

  let port = cfg.defaultPort;
  let ctx = cfg.defaultCtx;
  let threads = cfg.defaultThreads;

  if (choice === 'custom') {
    const portIn = await p.text({
      message: 'Port',
      placeholder: String(cfg.defaultPort),
      initialValue: String(cfg.defaultPort),
    });
    exitIfCancelled(portIn);
    port = parseInt(portIn, 10) || cfg.defaultPort;

    const ctxIn = await p.text({
      message: 'Context size',
      placeholder: String(cfg.defaultCtx),
      initialValue: String(cfg.defaultCtx),
    });
    exitIfCancelled(ctxIn);
    ctx = parseInt(ctxIn, 10) || cfg.defaultCtx;

    const threadsIn = await p.text({
      message: 'Threads',
      placeholder: String(cfg.defaultThreads),
      initialValue: String(cfg.defaultThreads),
    });
    exitIfCancelled(threadsIn);
    threads = parseInt(threadsIn, 10) || cfg.defaultThreads;
  }

  return { port, ctx, threads };
}

// Launch llama-server for a resolved model. Shared by the interactive and
// non-interactive paths. Detached (the default) leaves the server running
// after locca exits — stop it with `locca stop`, logs via `locca logs`, and
// the api block is printed. Foreground keeps locca attached as the server's
// supervisor (logs to stdout, exits with it) — a container's main process.
async function launchModel(
  cfg: Config,
  model: Model,
  {
    port,
    ctx,
    threads,
    foreground,
  }: { port: number; ctx: number; threads: number; foreground: boolean },
): Promise<void> {
  printStartupBanner(model, port, ctx);

  const child = launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads,
    extraArgs: [
      ...serverArgsForModel(basename(model.path)),
      ...mtpArgsForModel(model.path, cfg, cfg.llamaServer),
    ],
    noMmap: cfg.noMmap,
    parallel: cfg.defaultParallel,
    // Foreground → inherit stdio and block until the server exits; detached →
    // background the server and return so the api block can print.
    detached: !foreground,
  });

  if (foreground) {
    await superviseForeground(child, port, basename(model.path));
    return;
  }

  const ready = await waitReady(port, 60);
  if (!ready) {
    p.log.warn('Server did not become ready within 60s — run `locca logs` to see output.');
    return;
  }

  // Bring up the embedding sidecar if one is configured. Best-effort: a
  // failure here is reported but never blocks the chat server.
  const sidecar = await startEmbeddingSidecar(cfg);
  if (sidecar) {
    console.log(`  ${sidecar}`);
    console.log();
  }

  // Show the OpenAI-compatible connection info — same output as
  // `locca api`. Includes LAN / Tailscale URLs when bound to 0.0.0.0,
  // model name, endpoints, and a curl quick-test.
  await api();
  console.log(`  ${pc.dim('Stop with: locca stop  |  Logs: locca logs')}`);
  console.log();
}

/**
 * Foreground supervisor for container / systemd use: forward termination
 * signals to llama-server, clean up the PIDFILE, and resolve only when the
 * child exits — so the locca process (and the container) lives exactly as
 * long as the server does. Server stdout/stderr is already inherited, so its
 * logs stream straight to ours (i.e. `docker logs`).
 */
async function superviseForeground(
  child: ChildProcess,
  port: number,
  modelId: string,
): Promise<void> {
  console.log(
    `  ${pc.green('●')} Serving ${pc.cyan(modelId)} at ${pc.cyan(`http://localhost:${port}/v1`)} ${pc.dim('(bound to 0.0.0.0)')}`,
  );
  console.log(`  ${pc.dim('Ctrl-C / SIGTERM to stop — server logs stream below')}`);
  console.log();

  const forward = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  await new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      cleanupPidfile();
      // A clean signal stop is success; otherwise propagate the server's exit
      // code so `docker run` / systemd see the real failure.
      process.exitCode = signal ? 0 : (code ?? 0);
      resolve();
    });
    child.on('error', (err) => {
      cleanupPidfile();
      p.log.error(`Failed to start llama-server: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}

function cleanupPidfile(): void {
  try {
    unlinkSync(PIDFILE);
  } catch {
    // never created or already gone
  }
}

function printStartupBanner(model: Model, port: number, ctx: number): void {
  console.log();
  console.log(pc.magenta(pc.bold('  Starting server...')));
  console.log(`  Model:   ${model.name}`);
  console.log(`  Port:    ${port}`);
  console.log(`  Context: ${ctx}`);
  console.log(`  GPU:     Vulkan (all layers)`);
  if (model.mmprojPath) {
    const f = model.mmprojPath.split('/').pop();
    console.log(`  Vision:  ${f}`);
  }
  console.log();
}
