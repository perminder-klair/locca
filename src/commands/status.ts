import { loadConfig } from '../config.js';
import { scanModels } from '../models.js';
import { serverStatus } from '../server.js';
import type { Config } from '../types.js';
import { header, pc } from '../ui.js';
import { formatGB, which } from '../util.js';

/**
 * Compact one-line server summary, used in the menu header so the user sees
 * what (if anything) is currently running before they pick an action.
 */
export async function renderServerLine(): Promise<void> {
  const cfg = loadConfig();
  const s = await serverStatus(cfg);
  if (!s.running) {
    console.log(pc.dim('  ○ No server running'));
    return;
  }
  const tag =
    s.source === 'pid'
      ? `pid ${s.pid}`
      : s.source === 'external'
        ? 'external'
        : 'attached';
  const bits: string[] = [];
  if (s.model) bits.push(s.model);
  bits.push(s.url);
  bits.push(tag);
  console.log(pc.green(`  ● Running: ${bits.join(', ')}`));
}

/** `pi-llm status` — full report on the server, llama.cpp binary, and models dir. */
export async function status(): Promise<void> {
  const cfg = loadConfig();
  header();

  await renderServerSection(cfg);
  console.log();
  renderLlamaSection(cfg);
  console.log();
  renderModelsSection(cfg);
  console.log();
}

async function renderServerSection(cfg: Config): Promise<void> {
  const s = await serverStatus(cfg);
  console.log(`  ${pc.magenta(pc.bold('Server'))}`);
  if (!s.running) {
    console.log(`    ${pc.dim('○ Not running')}`);
    console.log(`    ${pc.dim(`Default port ${cfg.defaultPort}`)}`);
    return;
  }
  const sourceLabel =
    s.source === 'pid'
      ? `pi-llm-managed (pid ${s.pid})`
      : s.source === 'external'
        ? 'external (configured serverUrl)'
        : 'attached (started outside pi-llm)';
  console.log(`    ${pc.green('● Running')}  ${pc.dim(sourceLabel)}`);
  console.log(`    Model        ${s.model ?? pc.dim('(unknown)')}`);
  console.log(`    URL          ${s.url}/v1`);

  // Live info from /props (ctx, slots) — best effort, short timeout.
  const live = await fetchProps(s.url);
  if (live) {
    if (live.ctx) {
      console.log(`    Context      ${live.ctx.toLocaleString()} tokens`);
    }
    if (live.slots) {
      console.log(`    Slots        ${live.slots}`);
    }
  }
}

function renderLlamaSection(cfg: Config): void {
  console.log(`  ${pc.magenta(pc.bold('llama.cpp'))}`);
  const path = which(cfg.llamaServer);
  if (!path) {
    console.log(`    ${pc.red('Not found')}  ${pc.dim(`(looking for: ${cfg.llamaServer})`)}`);
    console.log(`    ${pc.dim('Run `pi-llm setup` for install instructions.')}`);
    return;
  }
  console.log(`    ${path}`);
}

function renderModelsSection(cfg: Config): void {
  console.log(`  ${pc.magenta(pc.bold('Models'))}`);
  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    console.log(`    ${cfg.modelsDir}`);
    console.log(`    ${pc.dim('(no GGUF files found)')}`);
    return;
  }
  const totalBytes = models.reduce((s, m) => s + m.sizeBytes, 0);
  console.log(`    ${cfg.modelsDir}`);
  console.log(
    `    ${pc.dim(`${models.length} model${models.length === 1 ? '' : 's'}, ${formatGB(totalBytes)} GB total`)}`,
  );
}

interface PropsSummary {
  ctx?: number;
  slots?: number;
}

async function fetchProps(baseUrl: string): Promise<PropsSummary | null> {
  try {
    const r = await fetch(`${baseUrl}/props`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      default_generation_settings?: { n_ctx?: number };
      total_slots?: number;
    };
    return {
      ctx: data.default_generation_settings?.n_ctx,
      slots: data.total_slots,
    };
  } catch {
    return null;
  }
}
