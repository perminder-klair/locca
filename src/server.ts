import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { Config } from './types.js';

const RUNDIR = process.env.XDG_RUNTIME_DIR ?? '/tmp';
export const PIDFILE = join(RUNDIR, 'pi-llm-server.pid');
export const LOGFILE = join(RUNDIR, 'pi-llm-server.log');

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
 * `pid`      — pi-llm spawned this server (we own its lifecycle).
 * `external` — config.serverUrl is set; an externally-managed server.
 * `attached` — no PIDFILE, but something's responding on the local default
 *              port. Could be a llama-server started by hand, by a
 *              supervisor, or by another tool. We can use it but won't
 *              try to stop it.
 */
export type ServerSource = 'pid' | 'external' | 'attached';

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
export function isPortInUse(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 500,
): Promise<boolean> {
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
 * Resolve current server status, in priority order:
 *   1. `serverUrl` configured  → check that URL (source: 'external').
 *   2. PIDFILE exists + alive  → use that (source: 'pid').
 *   3. Local default port responds → use it (source: 'attached').
 *   4. Otherwise nothing.
 */
export async function serverStatus(cfg: Config): Promise<ServerStatus> {
  if (cfg.serverUrl) {
    const probe = await probeServer(cfg.serverUrl);
    if (!probe.alive) return { running: false };
    const u = new URL(cfg.serverUrl);
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === 'https:'
        ? 443
        : 80;
    return {
      running: true,
      source: 'external',
      url: cfg.serverUrl.replace(/\/$/, ''),
      port,
      model: probe.model,
    };
  }

  if (existsSync(PIDFILE)) {
    let pid = NaN;
    try {
      pid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
    } catch {
      // fall through to cleanup
    }
    if (Number.isFinite(pid) && isAlive(pid)) {
      const args = readArgs(pid);
      const portMatch = args.match(/--port\s+(\d+)/);
      const modelMatch = args.match(/--model\s+(\S+\.gguf)/);
      const port = portMatch ? parseInt(portMatch[1]!, 10) : cfg.defaultPort;
      return {
        running: true,
        source: 'pid',
        url: `http://127.0.0.1:${port}`,
        port,
        pid,
        model: modelMatch ? basename(modelMatch[1]!) : undefined,
      };
    }
    try {
      unlinkSync(PIDFILE);
    } catch {
      // ignore
    }
  }

  // Maybe something's already on our default port (a llama-server started
  // outside pi-llm — by hand, by a supervisor, by another tool).
  const localUrl = `http://127.0.0.1:${cfg.defaultPort}`;
  const probe = await probeServer(localUrl, 600);
  if (probe.alive) {
    return {
      running: true,
      source: 'attached',
      url: localUrl,
      port: cfg.defaultPort,
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

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export type StopResult =
  | { stopped: true; pid: number }
  | { stopped: false; reason: string };

/**
 * Stop the server pi-llm started. Refuses to touch externally-managed or
 * attached servers — those need to be stopped via the tool that started them.
 */
export async function stopServer(cfg: Config): Promise<StopResult> {
  const s = await serverStatus(cfg);
  if (!s.running) return { stopped: false, reason: 'no server running' };
  if (s.source === 'external') {
    return {
      stopped: false,
      reason: `external server (configured serverUrl: ${s.url}) — stop it where it was started`,
    };
  }
  if (s.source === 'attached') {
    return {
      stopped: false,
      reason: `server at ${s.url} wasn't started by pi-llm — stop it via whatever started it`,
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
    unlinkSync(PIDFILE);
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
  '--parallel',
  '1',
  '--cache-reuse',
  '256',
  '--batch-size',
  '1024',
  '--jinja',
];

export function buildServerArgs(opts: ServeOpts): string[] {
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
    '--ctx-size',
    String(opts.ctx),
  ];
  if (opts.mmprojPath) {
    args.splice(2, 0, '--mmproj', opts.mmprojPath);
  }
  return args;
}

/** Launch llama-server. Returns the child process; caller decides how to wait. */
export function launchServer(opts: ServeOpts): ChildProcess {
  const args = buildServerArgs(opts);
  if (opts.detached) {
    const fd = openSync(LOGFILE, 'a');
    const child = spawn(opts.llamaServer, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    if (child.pid) writeFileSync(PIDFILE, `${child.pid}\n`);
    return child;
  }
  const child = spawn(opts.llamaServer, args, { stdio: 'inherit' });
  if (child.pid) writeFileSync(PIDFILE, `${child.pid}\n`);
  return child;
}

/**
 * Poll /health until server responds or timeout.
 *
 * Why /health and not /v1/models: /health flips green as soon as the HTTP
 * listener binds, which on big models is 10–30s before weights finish
 * loading. /v1/models only answers post-load, which made waitReady time out
 * spuriously. /health is the canonical HTTP liveness probe.
 */
export async function waitReady(port: number, timeoutSec = 60): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
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
