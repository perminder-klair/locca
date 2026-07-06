import type { ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { isEmbeddingModelName, mtpArgsForModel, serverArgsForModel } from '../catalog.js';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { type CommonServeFlags, parseCommonServeFlags, strFlag } from '../flags.js';
import { findMatches, pickModel, scanModels } from '../models.js';
import { refuseIfPortTaken } from '../preflight.js';
import { parseDuration, runIdleProxy } from '../proxy.js';
import {
  PIDFILE,
  type ServeOpts,
  isAlive,
  launchServer,
  serverStatus,
  stopServer,
  tailLog,
  waitForPortFree,
  waitReady,
} from '../server.js';
import type { Config, Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';
import { api } from './api.js';
import { startEmbeddingSidecar } from './embed.js';

// Parsed `locca serve` invocation. A positional pattern (or `--yes`) switches
// serve into non-interactive mode — no Clack prompts, defaults filled from
// config, suitable for scripts / CI / a parent process managing locca.
interface ServeArgs extends CommonServeFlags {
  // Foreground: locca supervises llama-server in the foreground instead of
  // detaching — logs stream to stdout, SIGTERM/Ctrl-C stops it cleanly, and
  // locca exits with the server. The right shape for a container's PID 1.
  foreground: boolean;
  // Raw `--idle-timeout` value (e.g. "15m"). When set, serve runs the
  // foreground idle-unload proxy instead of a plain launch. Parsed (and
  // validated) in serve() so an invalid value reports a clear error.
  idleTimeoutRaw?: string;
}

function parseServeArgs(rest: string[]): ServeArgs {
  let foreground = false;
  let idleTimeoutRaw: string | undefined;
  const common = parseCommonServeFlags(rest, (a, take) => {
    if (a === '--foreground' || a === '-f') {
      foreground = true;
      return true;
    }
    if (a === '--idle-timeout' || a.startsWith('--idle-timeout=')) {
      idleTimeoutRaw = strFlag('--idle-timeout', a, take);
      return true;
    }
    return false;
  });
  return { ...common, foreground, idleTimeoutRaw };
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
    // (locca manages one chat server: starting a new one replaces the old,
    // even when the ports differ.)
    p.log.info(
      `Stopping current server (pid ${status.pid}, port ${status.port}) to start a new one...`,
    );
    await stopServer(cfg);
    if (!(await waitForPortFree(status.port))) {
      p.log.error(`Old server did not release port ${status.port} within 10s — try again.`);
      process.exit(1);
    }
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

  // --idle-timeout switches serve into the foreground idle-unload proxy. Parse
  // and validate here so a bad value fails fast with a helpful message.
  let idleTimeout: number | undefined;
  if (args.idleTimeoutRaw !== undefined) {
    const sec = parseDuration(args.idleTimeoutRaw);
    if (sec === null) {
      p.log.error(
        `Invalid --idle-timeout '${args.idleTimeoutRaw}' — use e.g. 30s, 15m, 1h, or a number of seconds.`,
      );
      process.exit(1);
    }
    idleTimeout = sec;
  }

  await refuseIfPortTaken(port);
  await launchModel(cfg, model, {
    port,
    ctx,
    threads,
    host: args.host ?? cfg.defaultHost,
    apiKey: args.apiKey,
    foreground: args.foreground,
    idleTimeout,
  });
}

// Resolve the model in non-interactive mode. A pattern fuzzy-matches the full
// model list the same way `locca pi <pattern>` does; with no pattern (`--yes`
// alone) we serve the sole chat model if there's exactly one, else we refuse
// rather than guess. Exits the process on any unresolvable case.
function resolveModelNonInteractive(args: ServeArgs, models: Model[], chatModels: Model[]): Model {
  if (args.pattern !== undefined) {
    const matches = findMatches(models, args.pattern);
    const m = matches[0];
    if (!m) {
      p.log.error(`No model matching '${args.pattern}' in the models dir.`);
      p.log.info(`Available: ${chatModels.map((c) => c.name).join(', ')}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      p.log.warn(`Pattern '${args.pattern}' matches ${matches.length} models — using '${m.name}'.`);
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
    host,
    apiKey,
    foreground,
    idleTimeout,
  }: {
    port: number;
    ctx: number;
    threads: number;
    host?: string;
    apiKey?: string;
    foreground: boolean;
    idleTimeout?: number;
  },
): Promise<void> {
  const bindHost = host ?? '0.0.0.0';
  // One launch template, reused for a plain launch and for every proxy respawn,
  // so a reloaded model is byte-identical to the original.
  const serveOpts: ServeOpts = {
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads,
    host: bindHost,
    extraArgs: [
      ...serverArgsForModel(basename(model.path)),
      ...mtpArgsForModel(model.path, cfg, cfg.llamaServer),
      ...(apiKey ? ['--api-key', apiKey] : []),
    ],
    noMmap: cfg.noMmap,
    parallel: cfg.defaultParallel,
  };

  // Idle-unload proxy: a foreground supervisor that frees VRAM after the model
  // sits idle and cold-starts it on the next request. llama-server runs on the
  // private internal port (proxy binds the user-facing one).
  if (idleTimeout !== undefined) {
    await runIdleProxy({
      serveOpts,
      publicHost: bindHost,
      publicPort: port,
      internalPort: port + 1,
      idleSec: idleTimeout,
      modelId: model.name,
    });
    return;
  }

  printStartupBanner(model, port, ctx);

  const child = launchServer({
    ...serveOpts,
    // Foreground → inherit stdio and block until the server exits; detached →
    // background the server and return so the api block can print.
    detached: !foreground,
  });

  if (foreground) {
    await superviseForeground(child, port, basename(model.path), bindHost);
    return;
  }

  const ready = await waitReady(port, 60, child.pid);
  if (!ready) {
    if (child.pid !== undefined && !isAlive(child.pid)) {
      p.log.error('llama-server exited during startup.');
      const tail = tailLog('chat');
      if (tail) p.log.message(pc.dim(tail));
      p.log.info('Full log: locca logs');
      await stopServer(cfg); // clears the pidfile
      process.exit(1);
    }
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
  bindHost: string,
): Promise<void> {
  console.log(
    `  ${pc.green('●')} Serving ${pc.cyan(modelId)} at ${pc.cyan(`http://localhost:${port}/v1`)} ${pc.dim(`(bound to ${bindHost})`)}`,
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
