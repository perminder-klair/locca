import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_FILE, loadConfig } from './config.js';
import {
  type HardwareInfo,
  probeHardware,
  readLlamaVersion,
} from './hardware.js';
import { ctxCapForBudget, scanModels } from './models.js';
import { PI_PROVIDER_KEY, piModelsJsonPath } from './pi-config.js';
import { LOGFILE, type ServerStatus, serverStatus } from './server.js';
import type { Config, Model } from './types.js';
import { have, which } from './util.js';

export type Severity = 'info' | 'warn' | 'error';

export interface Finding {
  severity: Severity;
  section: string;
  title: string;
  detail?: string;
  suggestion?: string;
}

export interface LogWarning {
  /** Human-readable label for what we matched. */
  label: string;
  /** How many times the pattern fired in the scanned window. */
  count: number;
  /** A representative line from the log. */
  example: string;
}

export interface DoctorReport {
  cfg: Config;
  hw: HardwareInfo;
  llamaServerPath: string | null;
  llamaServerVersion: string | null;
  models: Model[];
  status: ServerStatus;
  liveCtx?: number;
  liveCtxTrain?: number;
  logWarnings: LogWarning[];
  piInstalled: boolean;
  piModelsJsonExists: boolean;
  piHasLoccaProvider: boolean;
  findings: Finding[];
}

export async function runDoctor(cfg: Config = loadConfig()): Promise<DoctorReport> {
  const hw = probeHardware();
  const llamaServerPath = which(cfg.llamaServer);
  const llamaServerVersion = llamaServerPath ? readLlamaVersion(llamaServerPath) : null;
  const models = scanModels(cfg.modelsDir);
  const status = await serverStatus(cfg);

  let liveCtx: number | undefined;
  let liveCtxTrain: number | undefined;
  if (status.running) {
    const live = await fetchLiveCtx(status.url);
    liveCtx = live?.ctx;
    liveCtxTrain = live?.ctxTrain;
  }

  const logWarnings = scanLog(LOGFILE);
  const piInstalled = have('pi');
  const piState = inspectPiState();

  const findings = collectFindings({
    cfg,
    hw,
    llamaServerPath,
    llamaServerVersion,
    models,
    status,
    liveCtx,
    logWarnings,
    piInstalled,
    piState,
  });

  return {
    cfg,
    hw,
    llamaServerPath,
    llamaServerVersion,
    models,
    status,
    liveCtx,
    liveCtxTrain,
    logWarnings,
    piInstalled,
    piModelsJsonExists: piState.exists,
    piHasLoccaProvider: piState.hasLocca,
    findings,
  };
}

async function fetchLiveCtx(
  baseUrl: string,
): Promise<{ ctx?: number; ctxTrain?: number } | null> {
  try {
    const r = await fetch(`${baseUrl}/props`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      default_generation_settings?: { n_ctx?: number };
      n_ctx?: number;
      n_ctx_train?: number;
    };
    return {
      ctx: data.default_generation_settings?.n_ctx ?? data.n_ctx,
      ctxTrain: data.n_ctx_train,
    };
  } catch {
    return null;
  }
}

interface PiState {
  exists: boolean;
  hasLocca: boolean;
  loccaBaseUrl?: string;
  loccaModels: string[];
}

function inspectPiState(): PiState {
  const path = piModelsJsonPath();
  if (!existsSync(path)) {
    return { exists: false, hasLocca: false, loccaModels: [] };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      providers?: Record<
        string,
        { baseUrl?: string; models?: Array<{ id?: string }> }
      >;
    };
    const locca = cfg.providers?.[PI_PROVIDER_KEY];
    if (!locca) return { exists: true, hasLocca: false, loccaModels: [] };
    return {
      exists: true,
      hasLocca: true,
      loccaBaseUrl: locca.baseUrl,
      loccaModels: (locca.models ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id)),
    };
  } catch {
    return { exists: true, hasLocca: false, loccaModels: [] };
  }
}

/**
 * Scan the llama-server log for known warning patterns. We read at most the
 * last 64 KiB so this stays fast even on long-running servers.
 */
export function scanLog(logFile: string): LogWarning[] {
  if (!existsSync(logFile)) return [];
  let text = '';
  try {
    const buf = readFileSync(logFile);
    const slice = buf.length > 65536 ? buf.subarray(buf.length - 65536) : buf;
    text = slice.toString('utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');

  const patterns: Array<{ label: string; re: RegExp }> = [
    {
      label: 'outdated chat template (compatibility workaround applied)',
      re: /outdated\s+\w+\s+chat\s+template|compatibility\s+workarounds?/i,
    },
    {
      label: 'chat template render failure',
      re: /failed\s+to\s+apply\s+chat\s+template|template\s+render\s+error|jinja/i,
    },
    {
      label: 'context overflow / truncation',
      re: /\btruncated\s*=\s*1\b|context\s+(?:overflow|exceeded)/i,
    },
    {
      label: 'out of memory',
      re: /\b(?:OOM|out\s+of\s+memory|cudaErrorMemoryAllocation|VK_ERROR_OUT_OF)/i,
    },
    {
      label: 'cache_reuse / kv-unified disabled at load time',
      re: /cache_reuse\s+is\s+not\s+supported|requires\s+--kv-unified,\s+disabling/i,
    },
    {
      label: 'speculative decoding warnings',
      re: /no\s+implementations\s+specified\s+for\s+speculative/i,
    },
  ];

  const out: LogWarning[] = [];
  for (const p of patterns) {
    const hits = lines.filter((l) => p.re.test(l));
    if (hits.length === 0) continue;
    out.push({
      label: p.label,
      count: hits.length,
      example: hits[hits.length - 1]!.trim().slice(0, 240),
    });
  }
  return out;
}

interface CollectArgs {
  cfg: Config;
  hw: HardwareInfo;
  llamaServerPath: string | null;
  llamaServerVersion: string | null;
  models: Model[];
  status: ServerStatus;
  liveCtx?: number;
  logWarnings: LogWarning[];
  piInstalled: boolean;
  piState: PiState;
}

function collectFindings(args: CollectArgs): Finding[] {
  const out: Finding[] = [];

  // ── llama.cpp ─────────────────────────────────────────────────────
  if (!args.llamaServerPath) {
    out.push({
      severity: 'error',
      section: 'llama.cpp',
      title: `${args.cfg.llamaServer} not found in PATH`,
      suggestion: 'Run `locca setup` for install instructions.',
    });
  }

  // ── Models ────────────────────────────────────────────────────────
  if (!existsSync(args.cfg.modelsDir)) {
    out.push({
      severity: 'error',
      section: 'models',
      title: `modelsDir does not exist: ${args.cfg.modelsDir}`,
      suggestion:
        'Create it (`mkdir -p`) or change `modelsDir` in ~/.locca/config.json.',
    });
  } else if (args.models.length === 0) {
    out.push({
      severity: 'warn',
      section: 'models',
      title: `No GGUF files in ${args.cfg.modelsDir}`,
      suggestion: 'Use `locca download` or `locca search` to fetch one.',
    });
  }

  // ── Hardware ──────────────────────────────────────────────────────
  if (args.hw.gpus.length === 0) {
    out.push({
      severity: 'warn',
      section: 'hardware',
      title: 'No GPU detected',
      detail:
        'Neither nvidia-smi, rocm-smi, nor vulkaninfo reported a usable device. CPU-only inference will be slow.',
      suggestion:
        'Install your GPU vendor driver + Vulkan/CUDA/ROCm and rebuild llama.cpp with the matching backend.',
    });
  }
  if (args.hw.ramTotalMB < 8 * 1024) {
    out.push({
      severity: 'warn',
      section: 'hardware',
      title: `Only ${gb(args.hw.ramTotalMB)} GiB RAM total`,
      suggestion: 'Stick to small models (≤4B params). Bigger models will swap or OOM.',
    });
  }

  // ── Config ────────────────────────────────────────────────────────
  if (args.cfg.defaultThreads > args.hw.cpus) {
    out.push({
      severity: 'warn',
      section: 'config',
      title: `defaultThreads (${args.cfg.defaultThreads}) > cpu count (${args.hw.cpus})`,
      suggestion: `Drop to ${Math.max(1, args.hw.cpus - 2)} via \`locca config set defaultThreads ${Math.max(1, args.hw.cpus - 2)}\`.`,
    });
  }
  if (!args.cfg.vramBudgetMB) {
    const vendorVram = args.hw.gpus.find((g) => g.vramTotalMB)?.vramTotalMB;
    out.push({
      severity: 'info',
      section: 'config',
      title: 'vramBudgetMB is unset',
      detail:
        'locca caps auto-picked context size based on this hint. Without it, big models default to 128k ctx and may OOM at load time.',
      suggestion: vendorVram
        ? `Detected ${gb(vendorVram)} GiB VRAM — try \`locca config set vramBudgetMB ${vendorVram}\`.`
        : 'Set it in `locca config` once you know your GPU\'s VRAM.',
    });
  }
  if (args.cfg.defaultPort < 1024) {
    out.push({
      severity: 'warn',
      section: 'config',
      title: `defaultPort ${args.cfg.defaultPort} is privileged`,
      suggestion: 'Use a port ≥1024 (e.g. 8080, 8081).',
    });
  }

  // ── Server (running) ──────────────────────────────────────────────
  if (args.status.running && args.status.source === 'pid' && args.liveCtx) {
    const cap = ctxCapForBudget(args.cfg.vramBudgetMB);
    if (cap !== undefined && args.liveCtx > cap * 2) {
      out.push({
        severity: 'warn',
        section: 'server',
        title: `Live context (${args.liveCtx.toLocaleString()}) far exceeds the cap suggested by your VRAM budget (${cap.toLocaleString()})`,
        suggestion:
          'Restart with a smaller --ctx-size, or raise vramBudgetMB if you have more VRAM than configured.',
      });
    }
  }
  if (args.cfg.serverUrl && !args.status.running) {
    out.push({
      severity: 'error',
      section: 'server',
      title: `Configured serverUrl is unreachable: ${args.cfg.serverUrl}`,
      suggestion:
        'Start the external server, fix the URL via `locca setup`, or clear `serverUrl` to fall back to a local llama-server.',
    });
  }

  // ── Log warnings ──────────────────────────────────────────────────
  for (const w of args.logWarnings) {
    if (/outdated\s+\w+\s+chat\s+template/i.test(w.label)) {
      out.push({
        severity: 'warn',
        section: 'server log',
        title: w.label,
        detail: `${w.count} occurrence${w.count === 1 ? '' : 's'} in recent log. Example: ${w.example}`,
        suggestion:
          "Switch to the model's official IT GGUF (e.g. unsloth/<model>-it-GGUF). The compatibility shim partially works but the model often leaks turn delimiters.",
      });
    } else if (/render failure|template render/i.test(w.label)) {
      out.push({
        severity: 'error',
        section: 'server log',
        title: w.label,
        detail: w.example,
        suggestion:
          'Update llama.cpp to the latest release; if that doesn\'t help, try `--no-jinja` (loses tool-calling support) or pick a different GGUF.',
      });
    } else if (/out of memory/i.test(w.label)) {
      out.push({
        severity: 'error',
        section: 'server log',
        title: w.label,
        detail: w.example,
        suggestion: 'Reduce --ctx-size or pick a smaller quant.',
      });
    } else if (/context overflow/i.test(w.label)) {
      out.push({
        severity: 'info',
        section: 'server log',
        title: w.label,
        detail: `${w.count} occurrence${w.count === 1 ? '' : 's'} — long sessions hit the ctx limit and got truncated.`,
        suggestion:
          'Increase ctx if VRAM allows, or start fresh sessions for very long tasks.',
      });
    }
  }

  // ── Pi integration ────────────────────────────────────────────────
  if (args.piInstalled) {
    if (!args.piState.exists) {
      out.push({
        severity: 'info',
        section: 'pi',
        title: '~/.pi/agent/models.json not yet created',
        suggestion: 'It will be written automatically the first time you run `locca pi`.',
      });
    } else if (!args.piState.hasLocca) {
      out.push({
        severity: 'info',
        section: 'pi',
        title: 'pi has no `locca` provider entry',
        suggestion: 'Run `locca pi <model>` once — it will register the provider.',
      });
    } else if (
      args.status.running &&
      args.piState.loccaBaseUrl &&
      args.piState.loccaBaseUrl !== `${args.status.url}/v1`
    ) {
      out.push({
        severity: 'info',
        section: 'pi',
        title: `pi's locca baseUrl (${args.piState.loccaBaseUrl}) does not match the live server (${args.status.url}/v1)`,
        suggestion:
          'It will be rewritten on the next `locca pi` invocation. Safe to ignore otherwise.',
      });
    }
  }

  return out;
}

function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/**
 * Build a markdown summary suitable for piping into pi as the analysis
 * prompt. Includes everything the model needs to give specific advice
 * without inventing flags it can't see.
 */
export function summariseForPrompt(report: DoctorReport): string {
  const out: string[] = [];

  out.push('# locca deployment review');
  out.push('');
  out.push(
    'You are reviewing a local llama.cpp deployment managed by `locca`.',
    'Identify suboptimal settings and concrete improvements that fit *this* hardware,',
    'config, and model set. Recommend only flags or values that exist in llama.cpp',
    'and locca\'s config schema. Do not invent options.',
    'Do not suggest cloud providers or other backends — locca is local-only.',
    '',
    'OUTPUT RULES — follow strictly:',
    '- Use short bullet points only. No paragraphs.',
    '- No markdown headings (`#`, `##`), no bold/italic, no horizontal rules.',
    '- Each bullet ≤ 20 words.',
    '- Wrap exact flag/key names in single backticks (e.g. `--ctx-size`, `vramBudgetMB`).',
    '- Do not restate the input. Skip preamble. Start with the first bullet.',
    '',
  );

  out.push('## Hardware');
  out.push(`- CPUs: ${report.hw.cpus}`);
  out.push(
    `- RAM: ${(report.hw.ramTotalMB / 1024).toFixed(1)} GiB total, ${(report.hw.ramFreeMB / 1024).toFixed(1)} GiB free`,
  );
  if (report.hw.gpus.length === 0) {
    out.push('- GPU: none detected (CPU-only inference)');
  } else {
    for (const g of report.hw.gpus) {
      const mem = g.vramTotalMB
        ? ` — ${(g.vramTotalMB / 1024).toFixed(1)} GiB VRAM${g.vramFreeMB !== undefined ? ` (${(g.vramFreeMB / 1024).toFixed(1)} free)` : ''}`
        : '';
      out.push(`- GPU [${g.vendor}, via ${g.source}]: ${g.name}${mem}`);
    }
  }
  out.push('');

  out.push(`## Config (~/.locca/config.json)`);
  out.push('```json');
  out.push(JSON.stringify(report.cfg, null, 2));
  out.push('```');
  out.push('');

  out.push('## llama.cpp');
  out.push(`- Path: ${report.llamaServerPath ?? '(not in PATH)'}`);
  if (report.llamaServerVersion) {
    out.push(`- Version: ${report.llamaServerVersion.split('\n').slice(0, 3).join(' / ')}`);
  }
  out.push('');

  out.push('## Server (current state)');
  if (!report.status.running) {
    out.push('- Not running');
  } else {
    out.push(`- Source: ${report.status.source}`);
    out.push(`- URL: ${report.status.url}`);
    if (report.status.model) out.push(`- Model: ${report.status.model}`);
    if (report.liveCtx) out.push(`- Live n_ctx: ${report.liveCtx.toLocaleString()}`);
    if (report.liveCtxTrain) {
      out.push(`- Model n_ctx_train: ${report.liveCtxTrain.toLocaleString()}`);
    }
  }
  out.push('');

  out.push(`## Models (${report.models.length})`);
  for (const m of report.models.slice(0, 20)) {
    const v = m.hasVision ? ' [vision]' : '';
    out.push(`- ${m.name}  (${m.sizeGB.toFixed(1)} GiB)${v}`);
  }
  if (report.models.length > 20) {
    out.push(`- … and ${report.models.length - 20} more`);
  }
  out.push('');

  if (report.logWarnings.length > 0) {
    out.push('## Recent server log warnings');
    for (const w of report.logWarnings) {
      out.push(`- ${w.label} (×${w.count})`);
      out.push(`    > ${w.example}`);
    }
    out.push('');
  }

  if (report.findings.length > 0) {
    out.push('## Doctor findings');
    for (const f of report.findings) {
      const tag = f.severity.toUpperCase();
      out.push(`- [${tag}] ${f.section}: ${f.title}`);
      if (f.detail) out.push(`    ${f.detail}`);
      if (f.suggestion) out.push(`    → ${f.suggestion}`);
    }
    out.push('');
  }

  out.push('## Format');
  out.push(
    'Two sections, each a bulleted list. Keep total response under 20 bullets.',
    '',
    'Issues:',
    '- One bullet per problem. Name the symptom, then the fix value.',
    '- Order by impact (biggest first).',
    '',
    'Looks good:',
    '- Short bullets for things that are correctly configured. Skip if nothing fits.',
    '',
    'If everything is already optimal, say so in one bullet and stop.',
  );

  return out.join('\n');
}

export { CONFIG_FILE };
