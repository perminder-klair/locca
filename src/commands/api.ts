import { loadConfig } from '../config.js';
import { serverStatus } from '../server.js';
import { pc } from '../ui.js';
import { networkAddresses } from '../util.js';

/** `locca api` — print OpenAI-compatible connection info for the local server. */
export async function api(): Promise<void> {
  const cfg = loadConfig();
  const status = await serverStatus(cfg);

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
  console.log(`  ${pc.magenta(pc.bold('Endpoints (OpenAI)'))}`);
  console.log(`    ${baseUrl}/chat/completions   chat (use this for agents)`);
  console.log(`    ${baseUrl}/completions        raw text completion`);
  console.log(`    ${baseUrl}/embeddings         embeddings (if model supports)`);
  console.log(`    ${baseUrl}/models             list loaded models`);
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
