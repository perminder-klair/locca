import type { ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { isEmbeddingModelName, mtpArgsForModel, serverArgsForModel } from '../catalog.js';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { findFirstMatch, modelLine, pickModel, scanModels } from '../models.js';
import { refuseIfPortTaken } from '../preflight.js';
import { PIDFILE, launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import type { Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';
import { api } from './api.js';
import { startEmbeddingSidecar } from './embed.js';

interface ServeArgs {
  pattern?: string;
  /** True when `pattern` came from a CLI positional, so it wins over LOCCA_MODEL. */
  patternFromCli?: boolean;
  port?: number;
  ctx?: number;
  threads?: number;
  host?: string;
  foreground: boolean;
  yes: boolean;
  help: boolean;
}

const USAGE = `Usage: locca serve [model] [options]

Start the OpenAI-compatible API server with a model.

With no model argument and a TTY, prompts you to pick one. Pass a model
name (or set LOCCA_MODEL) to run head-less — required in Docker / CI where
there is no terminal to prompt on.

Arguments:
  model              Model name or substring to serve (e.g. "qwen3.5-9b"),
                     matched against files in your models dir.

Options:
  -p, --port <n>     Port to bind        (env LOCCA_PORT,    default: config defaultPort)
  -c, --ctx <n>      Context window      (env LOCCA_CTX,     default: config defaultCtx)
  -t, --threads <n>  CPU threads         (env LOCCA_THREADS, default: config defaultThreads)
  -H, --host <addr>  Address to bind     (env LOCCA_HOST,    default: 0.0.0.0)
  -f, --foreground   Run in the foreground, streaming llama-server logs to
                     stdout and staying up until killed — use this as a
                     container's main process (env LOCCA_FOREGROUND=1).
  -y, --yes          Accept defaults without prompting.
  -h, --help         Show this help.

Examples:
  locca serve                              # interactive pick (needs a TTY)
  locca serve qwen3.5-9b                    # head-less, config defaults
  locca serve qwen3.5-9b -p 8080 -c 16384   # head-less, explicit settings
  LOCCA_MODEL=qwen3.5-9b locca serve -f     # container entrypoint`;

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

function parseArgs(argv: string[]): ServeArgs {
  const out: ServeArgs = {
    foreground: envFlag('LOCCA_FOREGROUND'),
    yes: false,
    help: false,
  };
  // Env defaults first; an explicit CLI flag below overrides them.
  out.port = envInt('LOCCA_PORT');
  out.ctx = envInt('LOCCA_CTX');
  out.threads = envInt('LOCCA_THREADS');
  if (process.env.LOCCA_HOST) out.host = process.env.LOCCA_HOST;
  if (process.env.LOCCA_MODEL) out.pattern = process.env.LOCCA_MODEL;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-f':
      case '--foreground':
        out.foreground = true;
        break;
      case '-y':
      case '--yes':
        out.yes = true;
        break;
      case '-p':
      case '--port':
        out.port = parseInt(next() ?? '', 10) || out.port;
        break;
      case '-c':
      case '--ctx':
        out.ctx = parseInt(next() ?? '', 10) || out.ctx;
        break;
      case '-t':
      case '--threads':
        out.threads = parseInt(next() ?? '', 10) || out.threads;
        break;
      case '-H':
      case '--host':
        out.host = next() ?? out.host;
        break;
      default:
        // First bare (non-flag) token is the model pattern; an explicit CLI
        // arg wins over LOCCA_MODEL.
        if (!a.startsWith('-') && !out.patternFromCli) {
          out.pattern = a;
          out.patternFromCli = true;
        }
    }
  }
  return out;
}

export async function serve(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const cfg = loadConfig();

  // Interactive only when we have a terminal, no model was named, and the
  // user didn't ask to skip prompts. In a container (no TTY) we must never
  // block on a prompt — bail with a clear message instead.
  const interactive = Boolean(process.stdin.isTTY) && !args.pattern && !args.yes;

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
    if (!interactive) {
      console.error(
        `\nMount or download GGUF models into that directory first.\n` +
          `In Docker, bind-mount your models to it or set LOCCA_MODELS_DIR.`,
      );
    }
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

  let model: Model | null;
  if (args.pattern) {
    model = findFirstMatch(chatModels, args.pattern);
    if (!model) {
      p.log.error(`No chat model matching '${args.pattern}' in ${cfg.modelsDir}`);
      printAvailable(chatModels);
      process.exit(1);
    }
  } else if (interactive) {
    model = await pickModel(chatModels, 'Pick a model to serve');
    if (!model) return;
  } else {
    // No TTY and no model named — can't prompt, so guide the user.
    p.log.error(
      `No model specified and no terminal to prompt on.\n` +
        `Pass a model name (\`locca serve <model>\`) or set LOCCA_MODEL.`,
    );
    printAvailable(chatModels);
    process.exit(1);
  }

  let port = args.port ?? cfg.defaultPort;
  let ctx = args.ctx ?? cfg.defaultCtx;
  let threads = args.threads ?? cfg.defaultThreads;
  const host = args.host ?? '0.0.0.0';

  // Interactive settings prompt only when running interactively AND the user
  // didn't already pin the values on the command line / via env.
  const settingsPinned =
    args.port !== undefined || args.ctx !== undefined || args.threads !== undefined;
  if (interactive && !settingsPinned) {
    const choice = await p.select({
      message: 'Settings',
      options: [
        { value: 'default', label: `Default (port ${port}, ctx ${ctx})` },
        { value: 'custom', label: 'Custom' },
      ],
    });
    exitIfCancelled(choice);

    if (choice === 'custom') {
      const portIn = await p.text({
        message: 'Port',
        placeholder: String(port),
        initialValue: String(port),
      });
      exitIfCancelled(portIn);
      port = parseInt(portIn, 10) || port;

      const ctxIn = await p.text({
        message: 'Context size',
        placeholder: String(ctx),
        initialValue: String(ctx),
      });
      exitIfCancelled(ctxIn);
      ctx = parseInt(ctxIn, 10) || ctx;

      const threadsIn = await p.text({
        message: 'Threads',
        placeholder: String(threads),
        initialValue: String(threads),
      });
      exitIfCancelled(threadsIn);
      threads = parseInt(threadsIn, 10) || threads;
    }
  }

  await refuseIfPortTaken(port);

  printStartupBanner(model, port, ctx, host, cfg.llamaBundled?.backend);

  const child = launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads,
    host,
    extraArgs: [
      ...serverArgsForModel(basename(model.path)),
      ...mtpArgsForModel(model.path, cfg, cfg.llamaServer),
    ],
    noMmap: cfg.noMmap,
    parallel: cfg.defaultParallel,
    // Foreground: llama-server inherits our stdio and we block until it
    // exits — the right shape for a container's main process (logs go to
    // `docker logs`, SIGTERM stops the container, no orphaned daemon).
    // Otherwise detach and return, leaving the server up (`locca stop`).
    detached: !args.foreground,
  });

  if (args.foreground) {
    await runForeground(child, host, port, basename(model.path));
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
 * Foreground supervisor for container use: forward termination signals to
 * llama-server, clean up the PIDFILE, and resolve when the child exits so
 * the process (and the container) lives exactly as long as the server.
 */
async function runForeground(
  child: ChildProcess,
  host: string,
  port: number,
  modelId: string,
): Promise<void> {
  const advertise = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(
    `  ${pc.green('●')} Serving ${pc.cyan(modelId)} on ${pc.cyan(`http://${advertise}:${port}/v1`)}`,
  );
  console.log(`  ${pc.dim('Bound to')} ${host}:${port} ${pc.dim('— Ctrl-C / SIGTERM to stop')}`);
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

function printAvailable(models: Model[]): void {
  if (models.length === 0) return;
  console.error(`\nAvailable models:`);
  for (const m of models.slice(0, 30)) {
    console.error(`  ${modelLine(m)}`);
  }
  if (models.length > 30) console.error(`  …and ${models.length - 30} more`);
}

function printStartupBanner(
  model: Model,
  port: number,
  ctx: number,
  host: string,
  backend?: string,
): void {
  console.log();
  console.log(pc.magenta(pc.bold('  Starting server...')));
  console.log(`  Model:   ${model.name}`);
  console.log(`  Host:    ${host}`);
  console.log(`  Port:    ${port}`);
  console.log(`  Context: ${ctx}`);
  // We always pass `--n-gpu-layers 999`; the actual backend depends on the
  // llama.cpp build. Name it when we know it (bundled installs record it),
  // otherwise stay generic rather than claiming Vulkan on a CPU build.
  const accel =
    backend && backend !== 'cpu'
      ? `${backend} (all layers)`
      : backend === 'cpu'
        ? 'CPU'
        : 'GPU offload (--n-gpu-layers 999)';
  console.log(`  Accel:   ${accel}`);
  if (model.mmprojPath) {
    const f = model.mmprojPath.split('/').pop();
    console.log(`  Vision:  ${f}`);
  }
  console.log();
}
