import { loadConfig } from '../config.js';
import { serverStatus } from '../server.js';
import { pc } from '../ui.js';

/** `pi-llm api` — print OpenAI-compatible connection info for the local server. */
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
        ? `pi-llm (pid ${status.pid})`
        : status.source === 'external'
          ? 'external (configured serverUrl)'
          : 'attached (external process on local port)';
  } else if (cfg.serverUrl) {
    baseUrl = `${cfg.serverUrl.replace(/\/$/, '')}/v1`;
    const u = new URL(cfg.serverUrl);
    port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === 'https:'
        ? 443
        : 80;
  } else {
    port = cfg.defaultPort;
    baseUrl = `http://localhost:${port}/v1`;
  }

  console.log();
  console.log(`  ${pc.magenta(pc.bold('Connection info (OpenAI-compatible)'))}`);
  console.log();
  if (live) {
    console.log(pc.green(`  ● Server is running — ${sourceLabel}`));
  } else if (cfg.serverUrl) {
    console.log(pc.yellow(`  ! Configured serverUrl is not responding`));
  } else {
    console.log(pc.dim(`  ○ No server running — showing defaults from config`));
  }
  console.log();
  console.log(`  Base URL    ${pc.cyan(baseUrl)}`);
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
  // Suppress unused-var on `port` — exposed in case future output wants it.
  void port;
}
