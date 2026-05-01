/**
 * Memory-fit math for catalog entries. Two questions:
 *   1. Will this model run on my machine? (isCompatible)
 *   2. What's the largest context I should pick? (highestFittingCtx)
 *
 * Both are answered by the same affine model
 *   total(ctx) = weights · overheadMultiplier + ctxBytesPer1kTokens · ctx/1k
 * compared against a memory budget derived from `probeHardware()`.
 *
 * Numbers and formulas track LlamaBarn's CatalogEntry+Compatibility.swift so
 * the recommendations stay consistent across both tools.
 */
import { type CatalogEntry, familyOverhead } from './catalog.js';
import type { GpuInfo, HardwareInfo } from './hardware.js';

export const CTX_TIERS = [4096, 8192, 16384, 32768, 65536, 131072, 262144] as const;

/**
 * The "default ctx" we evaluate compatibility at. 4k tracks llama.cpp's
 * implicit default and gives every model a fair baseline.
 */
export const COMPAT_CTX_TOKENS = 4096;

const MIB = 1024 * 1024;

export type BudgetBasis = 'unified' | 'vram' | 'cpu';

export interface MemoryBudget {
  /** Bytes available for weights + KV cache after OS/overhead reservations. */
  budgetBytes: number;
  /** Pool the budget is computed against, in bytes. */
  totalBytes: number;
  basis: BudgetBasis;
  /** Short label for log lines, e.g. "32 GB unified RAM". */
  description: string;
  /** GPU we anchored on, if basis === 'vram'. */
  gpu?: GpuInfo;
}

const APPLE_OVERHEAD_BYTES = 2 * 1024 * MIB; // 2 GB, matches LlamaBarn
const VRAM_OVERHEAD_BYTES = 1 * 1024 * MIB; // discrete GPUs reserve a bit for OS/driver

/**
 * Pick the budget basis from detected hardware:
 *   - Apple Silicon (or any 'apple' GPU) → unified RAM, RAM·0.75 − 2 GB.
 *   - Discrete GPU with known VRAM (NVIDIA / AMD via vendor tools) → vramTotal·0.92 − 1 GB.
 *   - Anything else (integrated GPUs without VRAM data, CPU-only, AMD Strix Halo
 *     reported by vulkaninfo without a memory number) → unified RAM, same formula
 *     as Apple. RAM is the right pool there too: integrated GPUs draw from it.
 */
export function memoryBudget(hw: HardwareInfo): MemoryBudget {
  const ramBytes = hw.ramTotalMB * MIB;

  // Discrete GPU with measured VRAM wins.
  const discrete = hw.gpus.find(
    (g) =>
      (g.vendor === 'nvidia' || g.vendor === 'amd') &&
      g.vramTotalMB &&
      // Heuristic: integrated APUs sometimes report tiny VRAM (e.g. 512 MB).
      // If "VRAM" is < 4 GB and we have plenty of system RAM, prefer RAM.
      g.vramTotalMB * MIB > 4 * 1024 * MIB,
  );
  if (discrete?.vramTotalMB) {
    const totalBytes = discrete.vramTotalMB * MIB;
    return {
      budgetBytes: Math.max(0, totalBytes * 0.92 - VRAM_OVERHEAD_BYTES),
      totalBytes,
      basis: 'vram',
      gpu: discrete,
      description: `${formatGiB(totalBytes)} VRAM (${discrete.name})`,
    };
  }

  if (ramBytes === 0) {
    // Hardware probe failed entirely. Treat as no headroom — every model is
    // flagged incompatible until the user fixes detection.
    return {
      budgetBytes: 0,
      totalBytes: 0,
      basis: 'cpu',
      description: 'memory unknown',
    };
  }

  const apple = hw.gpus.some((g) => g.vendor === 'apple');
  return {
    budgetBytes: Math.max(0, ramBytes * 0.75 - APPLE_OVERHEAD_BYTES),
    totalBytes: ramBytes,
    basis: apple ? 'unified' : hw.gpus.length > 0 ? 'unified' : 'cpu',
    description: `${formatGiB(ramBytes)} ${apple ? 'unified RAM' : 'system RAM'}`,
  };
}

/** Bytes the model is predicted to occupy at the given context length. */
export function runtimeBytes(entry: CatalogEntry, ctxTokens: number): number {
  const { build, size, family } = entry;
  const weights = build.fileSize * familyOverhead(family);
  const ctx = (size.ctxBytesPer1kTokens * ctxTokens) / 1000;
  return weights + ctx;
}

export function isCompatible(
  entry: CatalogEntry,
  budget: MemoryBudget,
  ctxTokens: number = COMPAT_CTX_TOKENS,
): boolean {
  if (budget.budgetBytes <= 0) return false;
  if (ctxTokens > entry.size.ctxWindow) return false;
  return runtimeBytes(entry, ctxTokens) <= budget.budgetBytes;
}

/**
 * Reverses the budget formula to render a "needs X GB+ of RAM/VRAM" hint.
 * Snaps to common sizes so we don't say "needs 23.4 GB".
 */
export function incompatibilitySummary(
  entry: CatalogEntry,
  budget: MemoryBudget,
  ctxTokens: number = COMPAT_CTX_TOKENS,
): string | undefined {
  if (isCompatible(entry, budget, ctxTokens)) return undefined;

  if (ctxTokens > entry.size.ctxWindow) {
    const max = Math.round(entry.size.ctxWindow / 1024);
    return `model max is ${max}k ctx`;
  }

  const needBytes = runtimeBytes(entry, ctxTokens);
  let requiredTotal: number;
  let unitLabel: string;
  if (budget.basis === 'vram') {
    // need = total · 0.92 − 1 GB  ⇒  total = (need + 1 GB) / 0.92
    requiredTotal = (needBytes + VRAM_OVERHEAD_BYTES) / 0.92;
    unitLabel = 'VRAM';
  } else {
    // need = total · 0.75 − 2 GB  ⇒  total = (need + 2 GB) / 0.75
    requiredTotal = (needBytes + APPLE_OVERHEAD_BYTES) / 0.75;
    unitLabel = 'RAM';
  }
  const requiredGB = Math.ceil(requiredTotal / (1024 * MIB));
  const tiers = [8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192];
  const display = tiers.find((g) => g >= requiredGB) ?? requiredGB;
  return `needs ${display} GB+ ${unitLabel}`;
}

/**
 * Largest standard tier whose runtime memory fits the budget. Stops at the
 * model's native ctxWindow. Returns undefined if the model can't run at the
 * minimum tier (incompatible at any ctx).
 */
export function highestFittingCtx(entry: CatalogEntry, budget: MemoryBudget): number | undefined {
  let best: number | undefined;
  for (const ctx of CTX_TIERS) {
    if (ctx > entry.size.ctxWindow) break;
    if (isCompatible(entry, budget, ctx)) best = ctx;
    else break;
  }
  return best;
}

/** Pretty printer for tier labels: 32768 → "32k". */
export function ctxLabel(tokens: number): string {
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * MIB)).toFixed(0)} GB`;
}

/** Bytes → "4.2 GB" (decimal-ish, matches the rest of the CLI). */
export function formatBytesGB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * One-line "fits — 5.7 GB dl, 7.2 GB RAM, 64k ctx" hint for catalog rows.
 * `dl` is the GGUF download size; `RAM` is the predicted runtime memory at
 * the recommended ctx tier (so the user sees what'll actually be allocated,
 * not just disk usage).
 */
export function fitHint(entry: CatalogEntry, budget: MemoryBudget): string {
  const tier = highestFittingCtx(entry, budget);
  const dl = formatBytesGB(entry.build.fileSize);
  if (tier === undefined) {
    // Should only be called for compatible entries, but render defensively.
    return `${dl} dl`;
  }
  const ram = formatBytesGB(runtimeBytes(entry, tier));
  return `${dl} dl, ${ram} RAM, ${ctxLabel(tier)} ctx`;
}
