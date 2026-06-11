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

/**
 * `locca embed [model]` — start a dedicated embedding server on the embed port
 * (default 8090), independent of the chat server. Picks an embedding model
 * (filtered from `modelsDir`), launches llama-server with `--embeddings
 * --pooling <type>`, and prints the OpenAI-compatible connection info.
 */
export async function embed(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const port = portForRole(cfg, 'embed');

  // First positional may be a model name pattern (mirrors `locca pi <pattern>`).
  const pattern = args[0] && !args[0].startsWith('-') ? args[0] : undefined;

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

  const model = pattern
    ? findFirstMatch(pool, pattern)
    : await pickModel(pool, 'Pick an embedding model');
  if (!model) {
    if (pattern) p.log.error(`No model matching '${pattern}'`);
    return;
  }

  await refuseIfPortTaken(port);

  const ctx = launchEmbed(cfg, model, port);

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
export function launchEmbed(cfg: Config, model: Model, port: number): number {
  const info = embeddingInfoForModel(basename(model.path));
  const ctx = Math.min(info.ctxWindow ?? EMBED_CTX_CAP, EMBED_CTX_CAP);
  launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    port,
    ctx,
    threads: cfg.defaultThreads,
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
