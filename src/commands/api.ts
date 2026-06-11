import { embeddingInfoForModel } from '../catalog.js';
import { loadConfig } from '../config.js';
import { type ServerStatus, serverStatus } from '../server.js';
import { pc } from '../ui.js';
import { networkAddresses } from '../util.js';

/** `locca api` — print OpenAI-compatible connection info for the local server(s). */
export async function api(): Promise<void> {
  const cfg = loadConfig();
  const status = await serverStatus(cfg, 'chat');
  const embedStatus = await serverStatus(cfg, 'embed');

  let baseUrl: string;
  let port: number;
  let modelName = 'local';
  let live = false;
  let sourceLabel = '';

  if (status.running) {
    baseUrl = `${status.url}/v1`;
    port = status.port;
    modelName = status.model ?? 'local';
    live = true;
    sourceLabel =
      status.source === 'pid'
        ? `locca (pid ${status.pid})`
        : 'attached (external process on local port)';
  } else {
    port = cfg.defaultPort;
    baseUrl = `http://localhost:${port}/v1`;
  }

  console.log();
  console.log(`  ${pc.magenta(pc.bold('Connection info (OpenAI-compatible)'))}`);
  console.log();
  if (live) {
    console.log(pc.green(`  ● Server is running — ${sourceLabel}`));
  } else {
    console.log(pc.dim(`  ○ No server running — showing defaults from config`));
  }
  console.log();
  console.log(`  Base URL    ${pc.cyan(baseUrl)}`);

  // If we're talking to a local server, advertise any LAN / Tailscale IPs
  // that actually respond on the same port — saves the user from `ip a`
  // and a manual probe when pointing a phone or another machine at it.
  const isLocal = /\/\/(127\.0\.0\.1|localhost)\b/.test(baseUrl);
  if (live && isLocal) {
    const reachable = await probeReachableUrls(port);
    if (reachable.lan.length || reachable.tailscale.length) {
      console.log();
      console.log(`  ${pc.dim('Also reachable at:')}`);
      for (const ip of reachable.lan) {
        console.log(`    LAN          ${pc.cyan(`http://${ip}:${port}/v1`)}`);
      }
      for (const ip of reachable.tailscale) {
        console.log(`    Tailscale    ${pc.cyan(`http://${ip}:${port}/v1`)}`);
      }
    }
  }

  console.log(`  Model name  ${pc.cyan(modelName)}`);
  console.log(`  API key     any non-empty string (e.g. "unused") — not validated`);
  console.log(`              unless server was started with --api-key`);
  console.log();

  // Whether the *primary* server can actually embed. Probed, not assumed —
  // the old code advertised /embeddings unconditionally, which lied for chat
  // models. A chat server answers this probe with an immediate 500, so it's
  // cheap. A dedicated embedding server is reported in its own block below.
  const primaryEmbed = live ? await probeEmbeddings(baseUrl, modelName) : { ok: false };

  console.log(`  ${pc.magenta(pc.bold('Endpoints (OpenAI)'))}`);
  console.log(`    ${baseUrl}/chat/completions   chat (use this for agents)`);
  console.log(`    ${baseUrl}/completions        raw text completion`);
  console.log(`    ${baseUrl}/models             list loaded models`);
  console.log(
    `    ${baseUrl}/embeddings         ${embeddingsHint(primaryEmbed, live)}`,
  );
  console.log();
  const root = baseUrl.replace(/\/v1$/, '');
  console.log(`  ${pc.magenta(pc.bold('Native (debugging)'))}`);
  console.log(`    ${root}/health    liveness check`);
  console.log(`    ${root}/props     server config + sampling`);
  console.log(`    ${root}/slots     per-slot KV cache state`);
  console.log(`    ${root}/metrics   Prometheus metrics`);
  console.log();
  console.log(`  ${pc.magenta(pc.bold('Quick test'))}`);
  console.log(`    curl ${baseUrl}/chat/completions \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(
    `      -d '{"model":"${modelName}","messages":[{"role":"user","content":"Hello!"}]}'`,
  );
  console.log();

  // Dedicated embedding server block — only when one is actually up on the
  // embed port and it isn't the same process we just described.
  if (embedStatus.running && (!status.running || embedStatus.url !== status.url)) {
    await printEmbeddingBlock(embedStatus);
  }
}

/** Render the `/embeddings` endpoint hint based on a live probe. */
function embeddingsHint(probe: { ok: boolean; dim?: number; pooling?: string }, live: boolean): string {
  if (!live) return pc.dim('embeddings (probe when running)');
  if (!probe.ok) return pc.dim('not supported by the loaded model — use `locca embed`');
  const bits = [`${probe.dim}-dim`];
  if (probe.pooling) bits.push(`pooling ${probe.pooling}`);
  return pc.green(`✓ ${bits.join(', ')}`);
}

/** Print a full connection block for a dedicated embedding server. */
async function printEmbeddingBlock(status: Extract<ServerStatus, { running: true }>): Promise<void> {
  const baseUrl = `${status.url}/v1`;
  const modelName = status.model ?? 'local';
  const source =
    status.source === 'pid' ? `locca (pid ${status.pid})` : 'attached (external process)';
  const probe = await probeEmbeddings(baseUrl, modelName);

  console.log(`  ${pc.magenta(pc.bold('Embedding server'))}`);
  if (probe.ok) {
    console.log(pc.green(`  ● Running — ${source}`));
  } else {
    // Health is up (serverStatus said running) but the embeddings probe
    // failed — say so rather than implying it works.
    console.log(pc.yellow(`  ● Running — ${source} (embeddings probe failed; check \`locca logs embed\`)`));
  }
  console.log();
  console.log(`  Base URL    ${pc.cyan(baseUrl)}`);
  console.log(`  Model name  ${pc.cyan(modelName)}`);
  if (probe.ok) {
    // Pooling: prefer the live /props value; fall back to the catalog value we
    // launched the model with (many llama-server builds don't expose it in
    // /props). Honest either way — it's the pooling actually in effect.
    const pooling = probe.pooling ?? embeddingInfoForModel(modelName).pooling;
    console.log(`  Vectors     ${probe.dim}-dim${pooling ? ` · pooling ${pooling}` : ''}`);
  }
  console.log();
  console.log(`  ${pc.magenta(pc.bold('Quick test'))}`);
  console.log(`    curl ${baseUrl}/embeddings \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -d '{"model":"${modelName}","input":"hello world"}'`);
  console.log();
}

/**
 * POST a tiny input to `/embeddings` and read back the vector length, plus the
 * pooling type from `/props`. This is the honest test: a server "supports
 * embeddings" iff it returns a vector. Returns `{ ok: false }` on any failure
 * (chat models 500 here immediately, so it's cheap).
 */
async function probeEmbeddings(
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; dim?: number; pooling?: string }> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'locca embedding probe' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return { ok: false };
    const data = (await r.json()) as { data?: Array<{ embedding?: number[] }> };
    const dim = data.data?.[0]?.embedding?.length;
    if (typeof dim !== 'number' || dim === 0) return { ok: false };
    const pooling = await probePooling(baseUrl);
    return { ok: true, dim, pooling };
  } catch {
    return { ok: false };
  }
}

/** Read the pooling type from `/props`, mapping llama.cpp's numeric enum to a
 *  label. Returns undefined when the build doesn't expose it. */
async function probePooling(baseUrl: string): Promise<string | undefined> {
  try {
    const root = baseUrl.replace(/\/v1$/, '');
    const r = await fetch(`${root}/props`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return undefined;
    const d = (await r.json()) as {
      pooling_type?: number | string;
      default_generation_settings?: { pooling_type?: number | string };
    };
    const pt = d.pooling_type ?? d.default_generation_settings?.pooling_type;
    return poolingLabel(pt);
  } catch {
    return undefined;
  }
}

// llama.cpp's llama_pooling_type enum.
const POOLING_LABELS: Record<number, string> = {
  0: 'none',
  1: 'mean',
  2: 'cls',
  3: 'last',
  4: 'rank',
};

function poolingLabel(pt: number | string | undefined): string | undefined {
  if (pt === undefined) return undefined;
  if (typeof pt === 'string') return pt;
  return POOLING_LABELS[pt];
}

async function probeReachableUrls(port: number): Promise<{ lan: string[]; tailscale: string[] }> {
  const addrs = networkAddresses();
  const probe = async (ip: string): Promise<string | null> => {
    try {
      const r = await fetch(`http://${ip}:${port}/health`, {
        signal: AbortSignal.timeout(800),
      });
      return r.ok ? ip : null;
    } catch {
      return null;
    }
  };
  const [lan, tailscale] = await Promise.all([
    Promise.all(addrs.lan.map(probe)).then((arr) => arr.filter((x): x is string => x !== null)),
    Promise.all(addrs.tailscale.map(probe)).then((arr) =>
      arr.filter((x): x is string => x !== null),
    ),
  ]);
  return { lan, tailscale };
}
