import { type ChildProcess, spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from 'node:http';
import { buildServerArgs, isPortInUse, type ServeOpts, waitReady } from './server.js';
import { pc } from './ui.js';

/**
 * Parse an idle-timeout duration into seconds. Accepts `30s`, `15m`, `1h`, or a
 * bare integer (treated as seconds). Returns null for anything unparseable or
 * non-positive so the caller can reject with a clear message.
 */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 's').toLowerCase();
  const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * mult;
}

/** Render seconds back to a compact human string (`900` → `15m`, `90` → `90s`). */
function fmtDuration(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export interface IdleProxyOpts {
  /**
   * The launch template. `llamaServer`, `modelPath`, `ctx`, `threads`,
   * `extraArgs`, `noMmap`, `parallel`, and `mmprojPath` are taken verbatim so a
   * reloaded model is byte-identical to the original launch. `port`/`host`/
   * `detached` are overridden per (re)spawn — llama-server always runs on the
   * private internal port bound to 127.0.0.1.
   */
  serveOpts: ServeOpts;
  /** Public-facing bind host (e.g. `0.0.0.0`) — same as a normal serve. */
  publicHost: string;
  /** Public-facing port the proxy listens on (the user's `--port`). */
  publicPort: number;
  /** Private port llama-server binds (127.0.0.1 only). Conventionally port+1. */
  internalPort: number;
  /** Idle window in seconds before the model is unloaded to free VRAM. */
  idleSec: number;
  /** Model id for the banner and synthesized `/v1/models` while unloaded. */
  modelId: string;
}

// Hop-by-hop headers must not be forwarded across a proxy (RFC 7230 §6.1).
// Node manages framing itself, so passing these through corrupts the stream.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function filterHeaders(h: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const EMPTY = Buffer.alloc(0);

/**
 * Run llama-server behind a foreground reverse-proxy that unloads the model
 * after `idleSec` of no inference, then cold-starts it on the next request.
 *
 * Lifecycle is a small state machine (`down → starting → up → stopping`).
 * `ensureUp()` is single-flight: concurrent requests during a cold start all
 * await the one spawn. The idle reaper only unloads when nothing is in flight,
 * so a streaming generation is never cut. Resolves only on signal shutdown.
 */
export async function runIdleProxy(opts: IdleProxyOpts): Promise<void> {
  const { serveOpts, publicHost, publicPort, internalPort, idleSec, modelId } = opts;
  const idleMs = idleSec * 1000;

  if (internalPort > 65535) {
    fatal(`internal port ${internalPort} is out of range — pick a lower --port.`);
  }
  if (await isPortInUse(internalPort)) {
    fatal(
      `internal port ${internalPort} (used for the private llama-server) is already taken. ` +
        'Free it or choose a different --port.',
    );
  }

  type State = 'down' | 'starting' | 'up' | 'stopping';
  let state: State = 'down';
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let lastActivity = Date.now();
  let inFlight = 0;

  const log = (msg: string) => console.log(`  ${pc.magenta('[locca]')} ${msg}`);

  function spawnChild(): void {
    const args = buildServerArgs({
      ...serveOpts,
      port: internalPort,
      host: '127.0.0.1',
      detached: false,
    });
    const c = spawn(serveOpts.llamaServer, args, { stdio: 'inherit' });
    child = c;
    c.on('error', (err) => log(pc.red(`failed to spawn llama-server: ${err.message}`)));
    c.on('exit', (code, signal) => {
      if (child !== c) return; // superseded by a newer child
      if (state === 'stopping') return; // intentional — doStop() owns the transition
      // Unexpected exit while we believed it was up/starting: mark down so the
      // next inference request reloads it.
      child = null;
      state = 'down';
      log(
        pc.yellow(
          `llama-server exited (code ${code ?? '-'}, signal ${signal ?? '-'}) — will reload on next request`,
        ),
      );
    });
  }

  function doStart(): Promise<void> {
    state = 'starting';
    log(`loading ${pc.cyan(modelId)} …`);
    spawnChild();
    return waitReady(internalPort, 120).then((ok) => {
      if (!ok || !child) {
        try {
          child?.kill('SIGKILL');
        } catch {
          // already gone
        }
        child = null;
        state = 'down';
        throw new Error('model did not become ready within 120s');
      }
      state = 'up';
      log(pc.green('model ready'));
    });
  }

  function ensureUp(): Promise<void> {
    // A stop in progress must finish before we can (re)start cleanly.
    const afterStop = stopPromise ? stopPromise.catch(() => {}) : Promise.resolve();
    return afterStop.then(() => {
      if (state === 'up') return;
      if (startPromise) return startPromise;
      startPromise = doStart().finally(() => {
        startPromise = null;
      });
      return startPromise;
    });
  }

  function doStop(): Promise<void> {
    return new Promise((resolve) => {
      const c = child;
      if (!c) {
        state = 'down';
        resolve();
        return;
      }
      const finish = () => {
        child = null;
        state = 'down';
        resolve();
      };
      c.once('exit', finish);
      try {
        c.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
      // Hard-kill if it ignores SIGTERM.
      setTimeout(() => {
        try {
          c.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 5000).unref();
    });
  }

  function unload(): void {
    if (state !== 'up' || inFlight > 0) return;
    state = 'stopping';
    log(pc.dim(`idle ${fmtDuration(idleSec)} — unloading model, freeing VRAM`));
    stopPromise = doStop().finally(() => {
      stopPromise = null;
    });
  }

  // Keep llama-server alive for the duration of any upstream interaction so the
  // reaper can't cut a request mid-flight. Only `touchIdle` requests (real
  // inference) extend the idle deadline; metadata passthroughs don't.
  function holdInFlight(res: ServerResponse, touchIdle: boolean): void {
    inFlight++;
    if (touchIdle) lastActivity = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      if (touchIdle) lastActivity = Date.now();
    };
    res.on('close', release);
    res.on('finish', release);
  }

  function proxyForward(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const headers = filterHeaders(req.headers);
    headers.host = `127.0.0.1:${internalPort}`;
    delete headers['content-length'];
    if (body.length > 0) headers['content-length'] = String(body.length);

    const upstream = httpRequest(
      { host: '127.0.0.1', port: internalPort, method: req.method, path: req.url, headers },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, filterHeaders(ur.headers));
        ur.pipe(res);
      },
    );
    upstream.on('error', (err) => fail(res, 502, err));
    // Client hung up — tear down the upstream request too.
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0];

    // /health: the service IS up (just possibly cold). Never wakes the model,
    // never extends idle — so a healthcheck loop can't pin VRAM.
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    // /v1/models: synthesize while unloaded so model-discovery doesn't reload.
    if (method === 'GET' && path === '/v1/models') {
      if (state === 'up') {
        holdInFlight(res, false);
        proxyForward(req, res, EMPTY);
        return;
      }
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: modelId, object: 'model', created: 0, owned_by: 'locca' }],
      });
      return;
    }
    // Other non-mutating requests (web UI, /props, /metrics): pass through when
    // up, but never wake an unloaded model — only real inference should.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      if (state === 'up') {
        holdInFlight(res, false);
        proxyForward(req, res, EMPTY);
        return;
      }
      sendText(res, 503, 'model unloaded (idle) — issue an inference request to reload\n');
      return;
    }

    // Mutating request = inference. Cold-start if needed, count in-flight, and
    // reset the idle clock. Body is buffered so it survives the cold-start wait.
    holdInFlight(res, true);
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      fail(res, 400, e);
      return;
    }
    try {
      await ensureUp();
    } catch (e) {
      fail(res, 503, e);
      return;
    }
    proxyForward(req, res, body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, 502, err));
  });
  // Don't let Node's request/response timeouts sever a long generation or a
  // slow cold start — clients own their own timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  banner(opts);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(publicPort, publicHost, () => resolve());
  }).catch((err: NodeJS.ErrnoException) => {
    fatal(`failed to bind ${publicHost}:${publicPort} — ${err.message}`);
  });

  // Eager load: serve should serve. A failure here is fatal, same as `serve`.
  try {
    await ensureUp();
  } catch (e) {
    fatal(`model failed to load: ${e instanceof Error ? e.message : String(e)}`);
  }

  ready(publicPort, idleSec, publicHost);

  const tick = Math.max(1000, Math.min(5000, Math.floor(idleMs / 4)));
  const reaper = setInterval(() => {
    if (state === 'up' && inFlight === 0 && Date.now() - lastActivity > idleMs) unload();
  }, tick);
  reaper.unref();

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (sig: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log();
      log(`${sig} — stopping`);
      clearInterval(reaper);
      server.close();
      const c = child;
      if (!c) {
        resolve();
        return;
      }
      c.once('exit', () => resolve());
      try {
        c.kill('SIGTERM');
      } catch {
        resolve();
        return;
      }
      setTimeout(() => {
        try {
          c.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }, 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}

// Bodies are buffered in full so they survive a cold-start wait — cap them so
// a runaway client can't balloon the proxy's memory. 256 MB is far beyond any
// real inference payload.
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, code: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(body);
}

function fail(res: ServerResponse, code: number, err: unknown): void {
  if (res.headersSent) {
    try {
      res.destroy();
    } catch {
      // already torn down
    }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, code, { error: { message, type: 'locca_proxy' } });
}

function banner(opts: IdleProxyOpts): void {
  console.log();
  console.log(pc.magenta(pc.bold('  Starting server (idle-unload proxy)...')));
  console.log(`  Model:        ${opts.modelId}`);
  console.log(`  Port:         ${opts.publicPort} ${pc.dim('(proxy)')}`);
  console.log(`  Internal:     127.0.0.1:${opts.internalPort} ${pc.dim('(llama-server)')}`);
  console.log(`  Idle unload:  ${fmtDuration(opts.idleSec)}`);
  console.log();
}

function ready(port: number, idleSec: number, host: string): void {
  console.log();
  console.log(
    `  ${pc.green('●')} Serving at ${pc.cyan(`http://localhost:${port}/v1`)} ${pc.dim(`(bound to ${host})`)}`,
  );
  console.log(
    `  ${pc.dim(`Model unloads after ${fmtDuration(idleSec)} idle; first request after that reloads it (cold-start latency).`)}`,
  );
  console.log(`  ${pc.dim('Ctrl-C / SIGTERM to stop — server logs stream below')}`);
  console.log();
}

function fatal(msg: string): never {
  console.error(`  ${pc.red('✖')} ${msg}`);
  process.exit(1);
}
