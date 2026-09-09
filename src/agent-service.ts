import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type InputResponse } from 'eve/client';
import { z } from 'zod';
import { agentDataDir, openAgentStore, type AgentSession } from './agent-store.js';
import { claimAgentOwnership, type AgentRuntime } from './agent-runtime.js';
import { listWorkspace, readWorkspace, workspaceRoot } from './workspace.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = z.string().trim().min(1).max(50_000);
const sessionInput = z.object({
  message: text,
  workspace: z.string().min(1),
  title: z.string().max(120).optional(),
});
const jobInput = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: text,
  workspace: z.string().min(1),
  intervalMinutes: z.number().int().min(1).max(525600),
});

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 100_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function matchesToken(candidate: string, expected: string) {
  const a = Buffer.from(candidate),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server, 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startAgentService(config: Omit<AgentRuntime, 'pid'>) {
  const dir = agentDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const releaseOwnership = claimAgentOwnership(dir);
  process.once('exit', releaseOwnership);
  const store = openAgentStore(dir);
  const runtimeToken = randomBytes(32).toString('hex');
  let queued: Promise<void> = Promise.resolve();
  let inferencePending = 0;
  // Serialize model calls across sessions, including Eve's compaction calls.
  const inference = createServer((req, res) => {
    if (!matchesToken(req.headers.authorization?.replace(/^Bearer /, '') || '', runtimeToken)) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    const work = async () => {
      if (res.destroyed) return;
      const abort = new AbortController();
      res.once('close', () => abort.abort());
      try {
        if (req.url !== '/v1/chat/completions' || req.method !== 'POST')
          return send(res, 404, { error: 'Unknown inference route' });
        const input = (await body(req, 8_000_000)) as Record<string, unknown>;
        input.model = config.modelId;
        input.max_tokens = Math.min(4096, Math.floor(config.contextWindow / 2));
        const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]),
        });
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        });
        if (upstream.body)
          for await (const chunk of upstream.body) {
            if (res.destroyed) break;
            if (!res.write(chunk))
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
                };
                res.once('drain', done);
                res.once('close', done);
              });
          }
        res.end();
      } catch (error) {
        if (!res.headersSent) send(res, 502, { error: String(error) });
        else res.end();
      }
    };
    inferencePending++;
    queued = queued
      .then(work)
      .catch(() => {})
      .finally(() => {
        inferencePending--;
      });
  });
  const inferencePort = await listen(inference, 0);
  const evePort = await freePort();
  const eve = spawn(
    process.execPath,
    ['--import', join(root, 'dist/local-provider.js'), join(root, '.output/server/index.mjs')],
    {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        PORT: String(evePort),
        HOST: '127.0.0.1',
        LOCCA_AGENT_DATA_DIR: dir,
        LOCCA_RUNTIME_TOKEN: runtimeToken,
        LOCCA_MODEL_ID: config.modelId,
        LOCCA_CONTEXT_WINDOW: String(config.contextWindow),
        LOCCA_INFERENCE_URL: `http://127.0.0.1:${inferencePort}/v1`,
        LOCCA_INFERENCE_TOKEN: runtimeToken,
        EVE_TELEMETRY_DISABLED: '1',
        DO_NOT_TRACK: '1',
      },
    },
  );
  const client = new Client({
    host: `http://127.0.0.1:${evePort}`,
    auth: { basic: { username: 'locca', password: runtimeToken } },
  });
  try {
    await waitForEve(client, eve);
  } catch (error) {
    eve.kill();
    inference.close();
    store.close();
    throw error;
  }

  async function createSession(input: z.infer<typeof sessionInput>): Promise<AgentSession> {
    const workspace = await workspaceRoot(input.workspace);
    const created = await client.sessions.create({ message: input.message });
    const session = {
      id: created.session.state.sessionId,
      title: input.title || input.message.slice(0, 80),
      workspace,
      createdAt: Date.now(),
    };
    store.addSession(session);
    return session;
  }

  const origin = `http://127.0.0.1:${config.port}`;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== `127.0.0.1:${config.port}`)
        return send(res, 403, { error: 'Invalid host' });
      if (req.headers.origin && req.headers.origin !== origin)
        return send(res, 403, { error: 'Cross-origin request denied' });
      const url = new URL(req.url || '/', origin);
      const candidate = url.searchParams.get('token');
      if (url.pathname === '/' && candidate && matchesToken(candidate, config.token)) {
        res.writeHead(303, {
          'Set-Cookie': `locca=${config.token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: url.searchParams.has('workspace')
            ? `/?workspace=${encodeURIComponent(url.searchParams.get('workspace')!)}`
            : '/',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      const cookie = /(?:^|;\s*)locca=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (!matchesToken(cookie, config.token) && !matchesToken(bearer, config.token)) {
        if (url.pathname === '/') {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Open Locca with `locca agent` to sign in to your local workspace.');
        }
        return send(res, 401, { error: 'Open Locca with `locca agent` to reconnect.' });
      }
      if (url.pathname === '/api/status')
        return send(res, 200, {
          model: config.modelId,
          contextWindow: config.contextWindow,
          workspace: config.workspace,
          inferencePending,
          engine: 'eve',
          version: '2.0.0',
        });
      if (url.pathname === '/api/sessions') {
        if (req.method === 'GET') return send(res, 200, store.sessions());
        if (req.method === 'POST')
          return send(res, 201, await createSession(sessionInput.parse(await body(req))));
      }
      const route =
        /^\/api\/sessions\/([^/]+)(?:\/(events|message|respond|cancel|compact|files|file))?$/.exec(
          url.pathname,
        );
      if (route) {
        const id = decodeURIComponent(route[1]);
        const saved = store.session(id);
        if (!saved) return send(res, 404, { error: 'Conversation not found' });
        const session = client.sessions.attach(id);
        const action = route[2];
        if (req.method === 'GET' && action === 'events') {
          const startIndex = z.coerce
            .number()
            .int()
            .min(0)
            .parse(url.searchParams.get('after') || '0');
          const events = [];
          for await (const event of session.stream({ startIndex, follow: false }))
            events.push(event);
          return send(res, 200, { events, cursor: startIndex + events.length });
        }
        if (req.method === 'GET' && action === 'files')
          return send(
            res,
            200,
            await listWorkspace(saved.workspace, url.searchParams.get('path') || '.'),
          );
        if (req.method === 'GET' && action === 'file')
          return send(res, 200, {
            content: await readWorkspace(saved.workspace, url.searchParams.get('path') || ''),
          });
        if (req.method === 'POST' && action === 'message') {
          const input = z.object({ message: text }).parse(await body(req));
          await session.send(input.message);
          return send(res, 202, { ok: true });
        }
        if (req.method === 'POST' && action === 'respond') {
          const input = z
            .object({
              responses: z
                .array(
                  z.object({
                    requestId: z.string(),
                    optionId: z.string().optional(),
                    text: z.string().optional(),
                  }),
                )
                .min(1),
            })
            .parse(await body(req));
          await session.respond(input.responses as InputResponse[]);
          return send(res, 202, { ok: true });
        }
        if (req.method === 'POST' && action === 'cancel')
          return send(res, 200, await session.cancel({ tasks: true }));
        if (req.method === 'POST' && action === 'compact')
          return send(res, 200, await session.compact());
      }
      if (url.pathname === '/api/jobs') {
        if (req.method === 'GET') return send(res, 200, store.jobs());
        if (req.method === 'POST') {
          const input = jobInput.parse(await body(req));
          const job = {
            ...input,
            workspace: await workspaceRoot(input.workspace),
            id: randomUUID(),
            nextRun: Date.now() + input.intervalMinutes * 60_000,
            enabled: 1,
            lastSession: null,
            error: null,
          };
          store.addJob(job);
          return send(res, 201, job);
        }
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
        store.deleteJob(decodeURIComponent(url.pathname.slice('/api/jobs/'.length)));
        return send(res, 200, { ok: true });
      }
      const assets: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'],
        '/events.js': ['events.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/fonts/manrope.woff2': ['fonts/manrope.woff2', 'font/woff2'],
        '/fonts/mono.woff2': ['fonts/mono.woff2', 'font/woff2'],
      };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, contentType] = assets[url.pathname];
        res.writeHead(200, {
          'Content-Type': `${contentType}; charset=utf-8`,
          'Cache-Control': 'no-store',
        });
        return res.end(await readFile(join(root, 'web', file)));
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent)
        send(res, error instanceof z.ZodError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      else res.end();
    }
  });

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const job of store.jobs()) {
        if (!job.enabled || job.nextRun > Date.now()) continue;
        try {
          if (job.lastSession) {
            const snapshot = await client.sessions.attach(job.lastSession).snapshot();
            const last = snapshot.events.at(-1);
            const pending = new Set<string>();
            for (const event of snapshot.events) {
              if (event.type === 'input.requested')
                for (const request of event.data.requests) pending.add(request.requestId);
              if (event.type === 'input.resolved')
                for (const resolution of event.data.resolutions)
                  pending.delete(resolution.requestId);
            }
            if (
              pending.size ||
              !last ||
              !['session.waiting', 'session.failed', 'session.completed'].includes(last.type)
            )
              continue;
          }
          // Reserve the next tick before dispatch so restart never replays a backlog.
          store.finishJob(job.id, Date.now() + job.intervalMinutes * 60_000, job.lastSession, null);
          const session = await createSession({
            message: job.prompt,
            workspace: job.workspace,
            title: job.title,
          });
          store.finishJob(job.id, Date.now() + job.intervalMinutes * 60_000, session.id, null);
        } catch (error) {
          store.finishJob(
            job.id,
            Date.now() + job.intervalMinutes * 60_000,
            job.lastSession,
            String(error),
          );
        }
      }
    } finally {
      ticking = false;
    }
  }, 10_000);

  const stateFile = join(dir, 'service.json');
  let closing = false;
  const shutdown = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    server.close();
    inference.close();
    eve.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => eve.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (eve.exitCode === null && eve.signalCode === null) eve.kill('SIGKILL');
    try {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      if (saved.pid === process.pid) await unlink(stateFile);
    } catch {}
    store.close();
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  eve.on('exit', () => {
    if (!closing) {
      console.error('Eve runtime exited.');
      void shutdown(1);
    }
  });
  try {
    await listen(server, config.port);
    await writeFile(stateFile, JSON.stringify({ ...config, pid: process.pid }), { mode: 0o600 });
    console.log(`Locca agent listening on ${origin}`);
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}

async function waitForEve(client: Client, child: ChildProcess) {
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  for (let i = 0; i < 120; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Eve failed to start. See the agent log.');
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Eve did not become ready within 60 seconds.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as Omit<AgentRuntime, 'pid'>;
  await startAgentService(config);
}
