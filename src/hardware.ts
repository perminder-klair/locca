import { spawnSync } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';

export type GpuVendor = 'amd' | 'nvidia' | 'intel' | 'apple' | 'unknown';
export type GpuSource = 'rocm-smi' | 'nvidia-smi' | 'vulkaninfo' | 'system_profiler';

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramTotalMB?: number;
  vramFreeMB?: number;
  source: GpuSource;
}

export interface HardwareInfo {
  cpus: number;
  ramTotalMB: number;
  ramFreeMB: number;
  gpus: GpuInfo[];
}

export function probeHardware(): HardwareInfo {
  // RAM doesn't change at runtime — cache to avoid re-running the slow GPU
  // probes (system_profiler is 1–2s on macOS) every time the menu redraws.
  // LOCCA_SIMULATE_MEM_GB lets us exercise the low-RAM compat path on a
  // beefy machine; mirrors LlamaBarn's BARN_SIMULATE_MEM_GB.
  if (cached) return cached;
  const ramTotalMB = simulatedRamMB() ?? Math.round(totalmem() / 1024 / 1024);
  cached = {
    cpus: cpus().length,
    ramTotalMB,
    ramFreeMB: Math.round(freemem() / 1024 / 1024),
    gpus: probeGpus(),
  };
  return cached;
}

let cached: HardwareInfo | undefined;

function simulatedRamMB(): number | undefined {
  const raw = process.env.LOCCA_SIMULATE_MEM_GB;
  if (!raw) return undefined;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb <= 0) return undefined;
  return Math.round(gb * 1024);
}

// Order matters: vendor-specific probes first (they report VRAM accurately);
// vulkaninfo is a name-only fallback for integrated GPUs that the vendor
// tools don't see.
function probeGpus(): GpuInfo[] {
  const out: GpuInfo[] = [];
  out.push(...probeNvidia());
  out.push(...probeRocm());
  if (process.platform === 'darwin') out.push(...probeMacOS());
  if (out.length === 0) out.push(...probeVulkan());
  return out;
}

function probeNvidia(): GpuInfo[] {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 2000 },
  );
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, total, free] = line.split(',').map((s) => s.trim());
      return {
        vendor: 'nvidia' as const,
        name: name || 'NVIDIA GPU',
        vramTotalMB: total ? parseInt(total, 10) : undefined,
        vramFreeMB: free ? parseInt(free, 10) : undefined,
        source: 'nvidia-smi' as const,
      };
    });
}

function probeRocm(): GpuInfo[] {
  const r = spawnSync('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, Record<string, string>>;
    const out: GpuInfo[] = [];
    for (const [card, fields] of Object.entries(parsed)) {
      if (!card.startsWith('card')) continue;
      const name = fields['Card Series'] ?? fields['Card SKU'] ?? fields['Device Name'] ?? card;
      const total = fields['VRAM Total Memory (B)'];
      const used = fields['VRAM Total Used Memory (B)'];
      const totalMB = total ? Math.round(parseInt(total, 10) / 1024 / 1024) : undefined;
      const usedMB = used ? Math.round(parseInt(used, 10) / 1024 / 1024) : undefined;
      out.push({
        vendor: 'amd',
        name,
        vramTotalMB: totalMB,
        vramFreeMB: totalMB !== undefined && usedMB !== undefined ? totalMB - usedMB : undefined,
        source: 'rocm-smi',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function probeVulkan(): GpuInfo[] {
  const r = spawnSync('vulkaninfo', ['--summary'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const out: GpuInfo[] = [];
  // Sections look like:
  //   GPU0:
  //     deviceName         = AMD Radeon Graphics (RADV RENOIR)
  //     deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
  const sections = r.stdout.split(/^GPU\d+:/m).slice(1);
  for (const sec of sections) {
    const nameMatch = sec.match(/deviceName\s*=\s*(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    // Skip software rasterisers — Mesa exposes llvmpipe / swrast as fake GPUs.
    if (/llvmpipe|swrast|software/i.test(name)) continue;
    out.push({ vendor: classify(name), name, source: 'vulkaninfo' });
  }
  return out;
}

function probeMacOS(): GpuInfo[] {
  // `system_profiler SPDisplaysDataType` is slow (1-2s), but it's the only
  // built-in source for Apple GPU info. Apple Silicon is unified memory, so
  // we don't try to estimate "VRAM" — total RAM is the budget.
  const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const data = JSON.parse(r.stdout) as {
      SPDisplaysDataType?: Array<{ sppci_model?: string; _name?: string }>;
    };
    const out: GpuInfo[] = [];
    for (const gpu of data.SPDisplaysDataType ?? []) {
      const name = gpu.sppci_model ?? gpu._name ?? 'Apple GPU';
      out.push({ vendor: classify(name), name, source: 'system_profiler' });
    }
    return out;
  } catch {
    return [];
  }
}

function classify(name: string): GpuVendor {
  if (/AMD|Radeon|RADV/i.test(name)) return 'amd';
  if (/NVIDIA|GeForce|RTX|GTX|Tesla|Quadro/i.test(name)) return 'nvidia';
  if (/Intel|Arc(?!h)/i.test(name)) return 'intel';
  if (/Apple|M[1-4]/i.test(name)) return 'apple';
  return 'unknown';
}

/** Read `llama-server --version` output. Returns null on failure. */
export function readLlamaVersion(binary: string): string | null {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000 });
  // llama-server prints version info to stderr and exits 1 — that's normal.
  const out = (r.stderr || r.stdout || '').trim();
  return out || null;
}
