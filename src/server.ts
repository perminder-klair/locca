import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { Config } from './types.js';

const RUNDIR = process.env.XDG_RUNTIME_DIR ?? '/tmp';

/**
 * locca can run two servers side by side: the chat/generative server (`serve`,
 * `pi`) and a dedicated embedding server (`embed`). Each gets its own PIDFILE,
 * logfile, and port so their lifecycles are independent.
 */
export type ServerRole = 'chat' | 'embed';

export function pidFile(role: ServerRole = 'chat'): string {
  return join(RUNDIR, role === 'embed' ? 'locca-embed.pid' : 'locca-server.pid');
}
export function logFile(role: ServerRole = 'chat'): string {
  return join(RUNDIR, role === 'embed' ? 'locca-embed.log' : 'locca-server.log');
}

/** Default port for a role: chat → `defaultPort`, embed → `defaultEmbedPort`. */
export function portForRole(cfg: Config, role: ServerRole = 'chat'): number {
  return role === 'embed' ? (cfg.defaultEmbedPort ?? 8090) : cfg.defaultPort;
}

// Back-compat aliases for the chat server's runtime files. Existing imports
// (`logs`, `pi`, docs) reference these directly.
export const PIDFILE = pidFile('chat');
export const LOGFILE = logFile('chat');

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * `pid`      — locca spawned this server (we own its lifecycle).
 * `attached` — no PIDFILE, but something's responding on the local default
 *              port. Could be a llama-server started by hand, by a
 *              supervisor, or by another tool. We can use it but won't
 *              try to stop it.
 */
export type ServerSource = 'pid' | 'attached';

export type ServerStatus =
  | { running: false }
  | {
      running: true;
      source: ServerSource;
      url: string;
      port: number;
      pid?: number;
      model?: string;
    };

/**
 * Quick TCP-connect check: is anything listening on the port?
 * Works without HTTP — used to distinguish "port free" from "port taken by
 * a non-llama service" (the probe-via-/health check can't tell them apart
 * since both return alive=false).
 */
export function isPortInUse(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host, timeout: timeoutMs });
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(v);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * Best-effort identification of whatever HTTP service is on `port`. Tries
 * the Server header and a `<title>` from the root document. Returns null
 * if the port isn't HTTP or we can't tell.
 */
export async function describePortOccupant(
  port: number,
  host = '127.0.0.1',
): Promise<string | null> {
  try {
    const r = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
    const server = r.headers.get('server');
    if (server) return server;
    const text = await r.text();
    const m = text.match(/<title>([^<]{1,80})<\/title>/i);
    if (m) return m[1]!.trim();
  } catch {
    // not HTTP or doesn't respond
  }
  return null;
}

/**
 * Probe `/props` for the values that don't show up in `/v1/models` —
 * applied context window and slot count. Returns `{}` on any failure so the
 * caller can render a partial status line without special-casing.
 *
 * Both fields are best-effort: older llama-server builds expose ctx under
 * different keys, and `total_slots` only appears when the build supports
 * multi-slot serving.
 */
export async function probeServerProps(
  baseUrl: string,
  timeoutMs = 1500,
): Promise<{ ctx?: number; slots?: number }> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/props`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return {};
    const data = (await r.json()) as {
      default_generation_settings?: { n_ctx?: number };
      n_ctx?: number;
      total_slots?: number;
    };
    const ctx = data.default_generation_settings?.n_ctx ?? data.n_ctx;
    const slots = data.total_slots;
    return {
      ctx: typeof ctx === 'number' ? ctx : undefined,
      slots: typeof slots === 'number' ? slots : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Probe a server's `/health` endpoint, optionally also fetching
 * `/v1/models` to discover the loaded model id.
 */
export async function probeServer(
  baseUrl: string,
  timeoutMs = 1500,
): Promise<{ alive: boolean; model?: string }> {
  const url = baseUrl.replace(/\/$/, '');
  let alive = false;
  try {
    const r = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    alive = r.ok;
  } catch {
    return { alive: false };
  }
  if (!alive) return { alive: false };
  let model: string | undefined;
  try {
    const r = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) {
      const data = (await r.json()) as { data?: Array<{ id?: string }> };
      model = data.data?.[0]?.id;
    }
  } catch {
    // /v1/models may still be loading; alive is what matters.
  }
  return { alive: true, model };
}

/**
 * Resolve current server status for a role, in priority order:
 *   1. role PIDFILE exists + alive  → use that (source: 'pid').
 *   2. Local role port responds     → use it (source: 'attached').
 *   3. Otherwise nothing.
 *
 * `role` defaults to `'chat'` so every existing caller is unchanged. Pass
 * `'embed'` to inspect the embedding sidecar (its own PIDFILE + port).
 */
export async function serverStatus(cfg: Config, role: ServerRole = 'chat'): Promise<ServerStatus> {
  const pf = pidFile(role);
  const rolePort = portForRole(cfg, role);
  if (existsSync(pf)) {
    let pid = NaN;
    try {
      pid = parseInt(readFileSync(pf, 'utf8').trim(), 10);
    } catch {
      // fall through to cleanup
    }
    if (Number.isFinite(pid) && isAlive(pid)) {
      const args = readArgs(pid);
      // PID-reuse guard: a stale pidfile can point at a recycled PID owned by
      // some unrelated process, and stopServer() would SIGTERM it. Only claim
      // the process when its argv visibly is our llama-server. Empty ps output
      // (transient failure) keeps the old trusting behaviour.
      if (args && !looksLikeLlamaArgs(args, cfg.llamaServer)) {
        try {
          unlinkSync(pf);
        } catch {
          // ignore
        }
      } else {
        const portMatch = args.match(/--port\s+(\d+)/);
        // Lazy match up to the first `.gguf` so paths containing spaces still
        // parse (ps gives us one flat string, so \S+ would stop at the space).
        const modelMatch = args.match(/--model\s+(.+?\.gguf)/);
        const port = portMatch ? parseInt(portMatch[1]!, 10) : rolePort;
        return {
          running: true,
          source: 'pid',
          url: `http://127.0.0.1:${port}`,
          port,
          pid,
          model: modelMatch ? basename(modelMatch[1]!) : undefined,
        };
      }
    } else {
      try {
        unlinkSync(pf);
      } catch {
        // ignore
      }
    }
  }

  // Maybe something's already on the role's port (a llama-server started
  // outside locca — by hand, by a supervisor, by another tool).
  const localUrl = `http://127.0.0.1:${rolePort}`;
  const probe = await probeServer(localUrl, 600);
  if (probe.alive) {
    return {
      running: true,
      source: 'attached',
      url: localUrl,
      port: rolePort,
      model: probe.model,
    };
  }

  return { running: false };
}

function readArgs(pid: number): string {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
  });
  return r.stdout?.trim() ?? '';
}

/**
 * Does this ps argv plausibly belong to the llama-server we launched?
 * Matches the configured binary (name or absolute path) or the generic
 * `llama-server` name, so a config pointing at e.g. `~/.locca/bin/.../
 * llama-server` still matches after PATH resolution.
 */
function looksLikeLlamaArgs(args: string, llamaServer: string): boolean {
  const bin = basename(llamaServer);
  return args.includes(bin) || args.includes('llama-server');
}

/**
 * Poll until nothing is listening on `port`. Used between stopping an old
 * server and launching its replacement — SIGTERM on a large model can take
 * well over the old fixed 500ms sleep to actually release the socket, which
 * made back-to-back model switches fail to bind intermittently.
 */
export async function waitForPortFree(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Last `lines` lines of a role's logfile, for inlining into launch-failure
 * messages so the user doesn't have to go run `locca logs` to learn that the
 * model file was bad. Null when the log doesn't exist / can't be read.
 */
export function tailLog(role: ServerRole = 'chat', lines = 12): string | null {
  try {
    const txt = readFileSync(logFile(role), 'utf8').trimEnd();
    if (!txt) return null;
    return txt.split('\n').slice(-lines).join('\n');
  } catch {
    return null;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export type StopResult = { stopped: true; pid: number } | { stopped: false; reason: string };

/**
 * Stop the server locca started. Refuses to touch attached servers —
 * those need to be stopped via the tool that started them.
 */
export async function stopServer(cfg: Config, role: ServerRole = 'chat'): Promise<StopResult> {
  const s = await serverStatus(cfg, role);
  if (!s.running) return { stopped: false, reason: 'no server running' };
  if (s.source === 'attached') {
    return {
      stopped: false,
      reason: `server at ${s.url} wasn't started by locca — stop it via whatever started it`,
    };
  }
  if (s.pid) {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  try {
    unlinkSync(pidFile(role));
  } catch {
    // ignore
  }
  return { stopped: true, pid: s.pid ?? 0 };
}

export interface ServeOpts {
  llamaServer: string;
  modelPath: string;
  mmprojPath?: string;
  port: number;
  ctx: number;
  threads: number;
  host?: string;
  detached?: boolean;
  /**
   * Extra flags appended after `COMMON_ARGS` (and after the explicit ctx-size).
   * Usually filled from `serverArgsForModel()` — per-family sampler defaults
   * plus `--alias`. Repeating a flag is fine: llama-server keeps the last
   * occurrence, so anything in here overrides the same flag in `COMMON_ARGS`.
   */
  extraArgs?: string[];
  /**
   * Pass `--no-mmap`. Opt-in per `cfg.noMmap` (default false) — only a
   * measured win on Strix Halo / unified-memory APUs; on dedicated-VRAM
   * GPUs and Apple Silicon mmap is faster and saves resident RAM.
   */
  noMmap?: boolean;
  /**
   * Concurrent server slots (`--parallel`). Defaults to 1 when omitted.
   * Usually filled from `cfg.defaultParallel`. llama-server splits
   * `--ctx-size` evenly across slots. Ignored in embedding mode.
   */
  parallel?: number;
  /**
   * `'chat'` (default) bakes in the generative flags (`COMMON_ARGS`:
   * `--jinja`, flash-attn, quantized KV cache, `--parallel`). `'embedding'`
   * swaps in `--embeddings --pooling … --ubatch-size <ctx>` and drops every
   * chat-only flag — that combination is what avoids llama.cpp's
   * "Pooling type 'none' is not OAI compatible" / "does not support embeddings"
   * walls.
   */
  mode?: 'chat' | 'embedding';
  /** Pooling type for embedding mode (`--pooling`). Defaults to `'mean'`. */
  pooling?: 'mean' | 'cls' | 'last';
  /** Which runtime files (PIDFILE/logfile) to write. Defaults to `'chat'`. */
  role?: ServerRole;
}

const COMMON_ARGS = [
  '--n-gpu-layers',
  '999',
  '--flash-attn',
  'on',
  '--cache-type-k',
  'q8_0',
  '--cache-type-v',
  'q8_0',
  '--cache-reuse',
  '256',
  '--batch-size',
  '1024',
  '--jinja',
];

const EMBED_ARGS = ['--n-gpu-layers', '999', '--embeddings'];

export function buildServerArgs(opts: ServeOpts): string[] {
  if (opts.mode === 'embedding') return buildEmbedArgs(opts);
  // Slot count: honour opts.parallel, but guard against bad/zero values.
  const parallel =
    Number.isInteger(opts.parallel) && (opts.parallel as number) > 0
      ? (opts.parallel as number)
      : 1;
  const args = [
    '--model',
    opts.modelPath,
    '--host',
    opts.host ?? '0.0.0.0',
    '--port',
    String(opts.port),
    '--threads',
    String(opts.threads),
    ...COMMON_ARGS,
    '--parallel',
    String(parallel),
    '--ctx-size',
    String(opts.ctx),
  ];
  if (opts.mmprojPath) {
    args.splice(2, 0, '--mmproj', opts.mmprojPath);
  }
  if (opts.noMmap) args.push('--no-mmap');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Argv for an embedding server. Deliberately *not* `COMMON_ARGS` + tweaks:
 *   - `--embeddings --pooling <type>` is what makes `/v1/embeddings` work and
 *     sidesteps the "Pooling type 'none'" error you get bolting `--embeddings`
 *     onto a chat launch.
 *   - `--ubatch-size == --batch-size == ctx`: non-causal encoder models must
 *     process the whole sequence in one micro-batch, so the ubatch has to be
 *     at least as large as the longest input.
 *   - No `--jinja`, no flash-attn, no quantized KV cache, no `--parallel`,
 *     no `--mmproj`, no sampler/MTP `extraArgs` — none apply to an encoder.
 */
function buildEmbedArgs(opts: ServeOpts): string[] {
  const args = [
    '--model',
    opts.modelPath,
    '--host',
    opts.host ?? '0.0.0.0',
    '--port',
    String(opts.port),
    '--threads',
    String(opts.threads),
    ...EMBED_ARGS,
    '--pooling',
    opts.pooling ?? 'mean',
    '--ctx-size',
    String(opts.ctx),
    '--ubatch-size',
    String(opts.ctx),
    '--batch-size',
    String(opts.ctx),
  ];
  if (opts.noMmap) args.push('--no-mmap');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/** Launch llama-server. Returns the child process; caller decides how to wait. */
export function launchServer(opts: ServeOpts): ChildProcess {
  const args = buildServerArgs(opts);
  const role = opts.role ?? 'chat';
  const pf = pidFile(role);
  if (opts.detached) {
    const fd = openSync(logFile(role), 'a');
    const child = spawn(opts.llamaServer, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    if (child.pid) writeFileSync(pf, `${child.pid}\n`);
    return child;
  }
  const child = spawn(opts.llamaServer, args, { stdio: 'inherit' });
  if (child.pid) writeFileSync(pf, `${child.pid}\n`);
  return child;
}

/**
 * Poll /health until server responds or timeout.
 *
 * Why /health and not /v1/models: /health flips green as soon as the HTTP
 * listener binds, which on big models is 10–30s before weights finish
 * loading. /v1/models only answers post-load, which made waitReady time out
 * spuriously. /health is the canonical HTTP liveness probe.
 *
 * Pass the spawned `pid` to fail fast when llama-server dies during startup
 * (bad GGUF, OOM at load) — otherwise a crashed launch still burns the whole
 * timeout before the caller learns anything.
 */
export async function waitReady(port: number, timeoutSec = 60, pid?: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (pid !== undefined && !isAlive(pid)) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}
