/**
 * Curated catalog of GGUF models with enough metadata to predict whether each
 * one will fit on the user's machine. The numbers below come from LlamaBarn's
 * hand-tuned data (Catalog/Families/Catalog+*.swift) — they're empirical fits,
 * not derived: ctxBytesPer1kTokens is the slope of the affine memory model
 *   total(ctx) = weights · overheadMultiplier + ctxBytesPer1kTokens · ctx/1k
 *
 * Quant choices follow Unsloth's published guidance:
 *   - Q4 = UD-Q4_K_XL ("Unsloth Dynamic" 4-bit) — recommended starting point.
 *   - Q8 = plain Q8_0 — near-lossless reference.
 * (UD-Q8_0 does not exist on HF for these repos; only the plain Q8 does.)
 *
 * To add a model: pick a family it fits into (or add a new one), add a
 * `CatalogSize` entry with the parameter count and ctx slope, then list one
 * `CatalogBuild` per quantization.
 */
export interface CatalogBuild {
  /** Quant tag, e.g. "Q4_K_M", "Q8_0", "UD-Q4_K_XL", "mxfp4". */
  quantization: string;
  /** Total bytes (sum of all parts for sharded models). Used for download
   *  progress and as the lower bound on resident weight memory. */
  fileSize: number;
  /** HF repo, e.g. "unsloth/Qwen3.5-9B-GGUF". */
  hfRepo: string;
  /** Exact GGUF filename to download. */
  hfFile: string;
  /** Additional shard filenames in the same repo. Empty for single-file models. */
  additionalParts?: string[];
  /** True iff this is the highest-precision build for this size (Q8_0 / mxfp4 / F16). */
  isFullPrecision: boolean;
}

export interface CatalogSize {
  /** Display label, e.g. "9B", "30B-A3B", "E2B". */
  name: string;
  /** Total parameter count (informational; sorting key for size). */
  parameterCount: number;
  /** Native max context window in tokens (model spec, not device-limited). */
  ctxWindow: number;
  /** KV-cache slope: bytes per 1000 tokens at the model's default cache types. */
  ctxBytesPer1kTokens: number;
  /** Builds, primary (full-precision) first, then quantized variants. */
  builds: CatalogBuild[];
  /** Vision projector (optional). When present, server boots with --mmproj. */
  mmprojRepo?: string;
  mmprojFile?: string;
  /** Override for the on-disk mmproj filename so we don't collide when several
   *  sizes ship the same `mmproj-F16.gguf`. */
  mmprojLocalFilename?: string;
}

export interface CatalogFamily {
  name: string;
  series: string;
  description: string;
  /** Sampler/server defaults the family was tuned with. */
  serverArgs?: string[];
  /** weights · overheadMultiplier ≈ resident bytes. Default 1.05. */
  overheadMultiplier?: number;
  /** Hidden from "browse catalog" but still recognised so installed copies
   *  carry the family's tuning. */
  deprecated?: boolean;
  sizes: CatalogSize[];
}

export interface CatalogEntry {
  id: string;
  family: CatalogFamily;
  size: CatalogSize;
  build: CatalogBuild;
  hasVision: boolean;
}

const DEFAULT_OVERHEAD = 1.05;

const QWEN_SAMPLER = ['--temp', '0.6', '--top-k', '20', '--top-p', '0.95', '--min-p', '0'];

export const catalog: CatalogFamily[] = [
  {
    name: 'Gemma 4',
    series: 'gemma',
    description:
      "Google's most capable open models, built from Gemini 3 technology. Multimodal, agentic, 140+ languages.",
    overheadMultiplier: 1.3,
    sizes: [
      {
        name: 'E2B',
        parameterCount: 5_123_178_051,
        ctxWindow: 131_072,
        ctxBytesPer1kTokens: 10_485_760,
        mmprojRepo: 'unsloth/gemma-4-E2B-it-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'gemma-4-E2B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 5_048_350_368,
            hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
            hfFile: 'gemma-4-E2B-it-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 3_174_043_296,
            hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
            hfFile: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
      {
        name: 'E4B',
        parameterCount: 7_996_156_490,
        ctxWindow: 131_072,
        ctxBytesPer1kTokens: 29_360_128,
        mmprojRepo: 'unsloth/gemma-4-E4B-it-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'gemma-4-E4B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 8_192_950_976,
            hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
            hfFile: 'gemma-4-E4B-it-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 5_101_718_208,
            hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
            hfFile: 'gemma-4-E4B-it-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
      {
        name: '26B-A4B',
        parameterCount: 25_805_936_206,
        ctxWindow: 262_144,
        ctxBytesPer1kTokens: 83_886_080,
        mmprojRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'gemma-4-26B-A4B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 26_859_859_264,
            hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
            hfFile: 'gemma-4-26B-A4B-it-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 17_090_276_672,
            hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
            hfFile: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
    ],
  },
  {
    name: 'Qwen 3.5 Small',
    series: 'qwen',
    description:
      "Alibaba's compact natively-multimodal reasoning models. Thinking/non-thinking modes for text and vision across 201 languages.",
    serverArgs: QWEN_SAMPLER,
    overheadMultiplier: 1.1,
    sizes: [
      {
        name: '2B',
        parameterCount: 1_887_854_608,
        ctxWindow: 262_144,
        ctxBytesPer1kTokens: 12_582_912,
        mmprojRepo: 'unsloth/Qwen3.5-2B-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'Qwen3.5-2B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 2_012_012_800,
            hfRepo: 'unsloth/Qwen3.5-2B-GGUF',
            hfFile: 'Qwen3.5-2B-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 1_339_752_704,
            hfRepo: 'unsloth/Qwen3.5-2B-GGUF',
            hfFile: 'Qwen3.5-2B-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
      {
        name: '9B',
        parameterCount: 8_960_348_656,
        ctxWindow: 262_144,
        ctxBytesPer1kTokens: 33_554_432,
        mmprojRepo: 'unsloth/Qwen3.5-9B-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'Qwen3.5-9B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 9_527_502_048,
            hfRepo: 'unsloth/Qwen3.5-9B-GGUF',
            hfFile: 'Qwen3.5-9B-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 5_966_095_584,
            hfRepo: 'unsloth/Qwen3.5-9B-GGUF',
            hfFile: 'Qwen3.5-9B-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
    ],
  },
  {
    name: 'Qwen 3.6',
    series: 'qwen',
    description:
      "Alibaba's next-gen multimodal reasoning models. Dense and MoE variants with strong coding and vision performance.",
    serverArgs: QWEN_SAMPLER,
    overheadMultiplier: 1.1,
    sizes: [
      {
        name: '27B',
        parameterCount: 26_895_998_464,
        ctxWindow: 262_144,
        ctxBytesPer1kTokens: 67_108_864,
        mmprojRepo: 'unsloth/Qwen3.6-27B-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'Qwen3.6-27B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 28_595_763_424,
            hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
            hfFile: 'Qwen3.6-27B-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 17_612_564_704,
            hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
            hfFile: 'Qwen3.6-27B-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
      {
        name: '35B-A3B',
        parameterCount: 34_660_610_688,
        ctxWindow: 262_144,
        ctxBytesPer1kTokens: 20_971_520,
        mmprojRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        mmprojFile: 'mmproj-F16.gguf',
        mmprojLocalFilename: 'Qwen3.6-35B-A3B-mmproj-F16.gguf',
        builds: [
          {
            quantization: 'Q8_0',
            fileSize: 36_903_140_320,
            hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
            hfFile: 'Qwen3.6-35B-A3B-Q8_0.gguf',
            isFullPrecision: true,
          },
          {
            quantization: 'UD-Q4_K_XL',
            fileSize: 22_360_456_160,
            hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
            hfFile: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
            isFullPrecision: false,
          },
        ],
      },
    ],
  },
];

/**
 * Generate a stable id like "gemma-4-e2b-q8-0".
 * Quant tag is included so multiple builds of the same size are addressable.
 */
function entryId(family: CatalogFamily, size: CatalogSize, build: CatalogBuild): string {
  const slug = `${family.name} ${size.name} ${build.quantization}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function makeEntry(family: CatalogFamily, size: CatalogSize, build: CatalogBuild): CatalogEntry {
  return {
    id: entryId(family, size, build),
    family,
    size,
    build,
    hasVision: Boolean(size.mmprojRepo && size.mmprojFile),
  };
}

export function allEntries(opts: { includeDeprecated?: boolean } = {}): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const family of catalog) {
    if (family.deprecated && !opts.includeDeprecated) continue;
    for (const size of family.sizes) {
      for (const build of size.builds) {
        out.push(makeEntry(family, size, build));
      }
    }
  }
  return out;
}

export function findEntryById(id: string): CatalogEntry | undefined {
  return allEntries({ includeDeprecated: true }).find((e) => e.id === id);
}

/**
 * Match a local filename (e.g. "Qwen3.5-9B-UD-Q4_K_XL.gguf") back to its
 * catalog entry. Used by ctxForModel and the switch flow to recover catalog
 * metadata for already-downloaded models. Filename comparison is
 * case-insensitive and tolerant of leading paths.
 */
export function findEntryByFilename(filename: string): CatalogEntry | undefined {
  const base = filename.split('/').pop()?.toLowerCase() ?? filename.toLowerCase();
  return allEntries({ includeDeprecated: true }).find((e) => e.build.hfFile.toLowerCase() === base);
}

/** Find the family that owns a given HF repo (any quant). */
export function findFamilyByRepo(repo: string): CatalogFamily | undefined {
  const r = repo.toLowerCase();
  return catalog.find((family) =>
    family.sizes.some((s) => s.builds.some((b) => b.hfRepo.toLowerCase() === r)),
  );
}

/** All entries belonging to a given HF repo (one per quant). */
export function entriesForRepo(repo: string): CatalogEntry[] {
  const r = repo.toLowerCase();
  return allEntries({ includeDeprecated: true }).filter((e) => e.build.hfRepo.toLowerCase() === r);
}

export function familyOverhead(family: CatalogFamily): number {
  return family.overheadMultiplier ?? DEFAULT_OVERHEAD;
}

/**
 * Pick the build to surface as the default in pickers when several variants
 * fit. Unsloth's docs specifically recommend Dynamic 4-bit (UD-Q4_K_XL) as
 * the starting point, so we mirror that: prefer non-full-precision when it
 * fits, fall back to full-precision, then to whatever's left.
 */
export function defaultBuild(variants: CatalogEntry[]): CatalogEntry | undefined {
  if (variants.length === 0) return undefined;
  return (
    variants.find((v) => !v.build.isFullPrecision) ??
    variants.find((v) => v.build.isFullPrecision) ??
    variants[0]
  );
}
