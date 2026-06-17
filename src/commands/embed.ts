import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { embeddingInfoForModel, isEmbeddingModelName } from '../catalog.js';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { findFirstMatch, pickModel, scanModels } from '../models.js';
import { refuseIfPortTaken } from '../preflight.js';
import {
  isPortInUse,
  launchServer,
  portForRole,
  serverStatus,
  stopServer,
  waitReady,
} from '../server.js';
import type { Config, Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';
import { api } from './api.js';

// Embedding encoders have small native windows; cap the ctx (and therefore the
// per-request ubatch buffer) so we don't over-allocate. 8192 covers nomic and
// bge-m3; mxbai's 512 is honoured as-is.
const EMBED_CTX_CAP = 8192;

// Parsed `locca embed` invocation. Mirrors `serve`'s flag set (minus the
// foreground / idle-timeout supervision options, which don't apply to the
// short-lived embedding encoder). A positional pattern or `--yes` switches
// embed into non-interactive mode — no Clack picker, suitable for scripts / CI.
interface EmbedArgs {
  pattern?: string;
  port?: number;
  ctx?: number;
  threads?: number;
  yes: boolean;
}

function parseEmbedArgs(rest: string[]): EmbedArgs {
  const out: EmbedArgs = { yes: false };
  const num = (s: string | undefined): number | undefined => {
    const n = parseInt(s ?? '', 10);
    return Number.isFinite(n) ? n : undefined;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--yes' || a === '-y') out.yes = true;
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

/**
 * `locca embed [model]` — start a dedicated embedding server on the embed port
 * (default 8090), independent of the chat server. Picks an embedding model
 * (filtered from `modelsDir`), launches llama-server with `--embeddings
 * --pooling <type>`, and prints the OpenAI-compatible connection info.
 *
 * A model name, `--yes`, or no TTY runs non-interactively (no picker), and
 * `--port`/`--ctx`/`--threads` override the config / catalog defaults.
 */
export async function embed(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const args = parseEmbedArgs(argv);
  // A CLI `--port` wins over `defaultEmbedPort`. Used everywhere below except
  // the status/stop check, which stays on the config role port (PID-based, so
  // the swap still works) — exactly how `serve` treats its top-of-function
  // status check vs `args.port`.
  const port = args.port ?? portForRole(cfg, 'embed');

  // Resolve who's on the embed port before requiring llama-server.
  const status = await serverStatus(cfg, 'embed');
  if (status.running) {
    if (status.source === 'attached') {
      p.log.error(
        `Something is already responding on embed port ${status.port} (${status.url}) — locca did not start it. Stop it via whatever started it before running \`locca embed\`.`,
      );
      process.exit(1);
    }
    p.log.info(`Stopping current embedding server (pid ${status.pid}) to start a new one...`);
    await stopServer(cfg, 'embed');
    await new Promise((r) => setTimeout(r, 500));
  }

  if (port === cfg.defaultPort) {
    p.log.error(
      `defaultEmbedPort (${port}) is the same as defaultPort — the embedding server can't share the chat server's port. Set a different defaultEmbedPort with \`locca config set defaultEmbedPort <port>\`.`,
    );
    process.exit(1);
  }

  requireLlama(cfg);

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  // Prefer embedding-classified models; if none are recognised, fall back to
  // the full list so a user who knows their model is an embedder can still
  // pick it (we warn after selection if it doesn't look like one).
  const embedModels = models.filter((m) => isEmbeddingModelName(m.name));
  const pool = embedModels.length > 0 ? embedModels : models;
  if (embedModels.length === 0) {
    p.log.warn(
      "No embedding models detected in your models dir. Download one with `locca download nomic-ai/nomic-embed-text-v1.5-GGUF` (or mxbai / bge-m3), or pick below if you know it's an embedder.",
    );
  }

  // A pattern, `--yes`, or no TTY (a container, a pipe, CI) means "don't prompt
  // me" — resolve from the pattern / sole embedding model instead of hanging on
  // the picker.
  const nonInteractive = args.pattern !== undefined || args.yes || !process.stdin.isTTY;
  const model = nonInteractive
    ? resolveEmbedModelNonInteractive(args, pool)
    : await pickModel(pool, 'Pick an embedding model');
  if (!model) return;

  await refuseIfPortTaken(port);

  const ctx = launchEmbed(cfg, model, port, { ctx: args.ctx, threads: args.threads });

  printStartupBanner(model, port, ctx);

  const ready = await waitReady(port, 60);
  if (!ready) {
    p.log.warn(
      'Embedding server did not become ready within 60s — run `locca logs embed` to see output.',
    );
    return;
  }

  await api();
  console.log(`  ${pc.dim('Stop with: locca stop  |  Logs: locca logs embed')}`);
  console.log();
}

/**
 * Launch the embedding server (detached) for `model` on `port`. Shared by the
 * `embed` command and the `serve` sidecar. Returns the ctx it used.
 */
export function launchEmbed(
  cfg: Config,
  model: Model,
  port: number,
  overrides?: { ctx?: number; threads?: number },
): number {
  const info = embeddingInfoForModel(basename(model.path));
  // An explicit `--ctx` is honoured verbatim — it's a deliberate choice that
  // also drives `--ubatch-size`/`--batch-size`. The bare command and the serve
  // sidecar (no overrides) keep the safe EMBED_CTX_CAP clamp.
  const ctx = overrides?.ctx ?? Math.min(info.ctxWindow ?? EMBED_CTX_CAP, EMBED_CTX_CAP);
  launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    port,
    ctx,
    threads: overrides?.threads ?? cfg.defaultThreads,
    mode: 'embedding',
    pooling: info.pooling,
    role: 'embed',
    extraArgs: info.alias ? ['--alias', info.alias] : [],
    noMmap: cfg.noMmap,
    detached: true,
  });
  return ctx;
}

/**
 * Best-effort embedding sidecar for `locca serve`. No-ops when
 * `cfg.defaultEmbedModel` is unset. Never throws — a failed sidecar must not
 * take down the chat server the user actually asked for. Returns a short
 * status line for the caller to print, or null when nothing was attempted.
 */
export async function startEmbeddingSidecar(cfg: Config): Promise<string | null> {
  if (!cfg.defaultEmbedModel) return null;
  const port = portForRole(cfg, 'embed');
  if (port === cfg.defaultPort) {
    return pc.yellow(`Embedding sidecar skipped: defaultEmbedPort (${port}) clashes with defaultPort.`);
  }

  const status = await serverStatus(cfg, 'embed');
  if (status.running) {
    return pc.dim(`Embedding server already running on :${status.port}.`);
  }
  if (await refuseIfPortTakenQuiet(port)) {
    return pc.yellow(`Embedding sidecar skipped: port ${port} is occupied by something else.`);
  }

  const models = scanModels(cfg.modelsDir);
  const model = findFirstMatch(models, cfg.defaultEmbedModel);
  if (!model) {
    return pc.yellow(
      `Embedding sidecar skipped: no model matching defaultEmbedModel='${cfg.defaultEmbedModel}'.`,
    );
  }

  const ctx = launchEmbed(cfg, model, port);
  const ready = await waitReady(port, 60);
  if (!ready) {
    return pc.yellow(
      `Embedding sidecar (${model.name}) did not become ready in 60s — see \`locca logs embed\`.`,
    );
  }
  return pc.green(`Embedding server up: ${model.name} on :${port} (ctx ${ctx}).`);
}

/** Like `refuseIfPortTaken` but returns a boolean instead of exiting — the
 *  sidecar must degrade gracefully, not kill the parent `serve`. */
async function refuseIfPortTakenQuiet(port: number): Promise<boolean> {
  return isPortInUse(port);
}

// Resolve the embedding model in non-interactive mode. A pattern fuzzy-matches
// the pool the same way `locca pi <pattern>` does; with no pattern (`--yes` or
// no TTY) we serve the sole candidate if there's exactly one, else we refuse
// rather than guess. Exits the process on any unresolvable case.
function resolveEmbedModelNonInteractive(args: EmbedArgs, pool: Model[]): Model {
  if (args.pattern !== undefined) {
    const m = findFirstMatch(pool, args.pattern);
    if (!m) {
      p.log.error(`No model matching '${args.pattern}' in the models dir.`);
      p.log.info(`Available: ${pool.map((c) => c.name).join(', ')}`);
      process.exit(1);
    }
    return m;
  }
  // `--yes` / no TTY with no pattern: only unambiguous with a single candidate.
  if (pool.length === 1) return pool[0];
  p.log.error('Multiple embedding models found — pass a model pattern, e.g. `locca embed bge --yes`.');
  p.log.info(`Available: ${pool.map((c) => c.name).join(', ')}`);
  process.exit(1);
}

function printStartupBanner(model: Model, port: number, ctx: number): void {
  const info = embeddingInfoForModel(basename(model.path));
  console.log();
  console.log(pc.magenta(pc.bold('  Starting embedding server...')));
  console.log(`  Model:   ${model.name}`);
  console.log(`  Port:    ${port}`);
  console.log(`  Context: ${ctx}`);
  console.log(`  Pooling: ${info.pooling}`);
  if (info.embedDim) console.log(`  Vectors: ${info.embedDim}-dim`);
  console.log(`  GPU:     Vulkan (all layers)`);
  console.log();
}
