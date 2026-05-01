import { spawnSync } from 'node:child_process';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { detectDistro } from './distro.js';
import { probeHardware } from './hardware.js';

/**
 * Manages downloading prebuilt llama.cpp binaries from upstream GitHub
 * releases so users without a system install can get going without
 * compiling. Writes binaries to ~/.locca/bin/llama-cpp/<build>-<backend>/
 * and returns the resolved absolute paths so the caller can persist them
 * to config.
 */

const LLAMA_REPO = 'ggml-org/llama.cpp';
const LLAMA_BIN_DIR = join(homedir(), '.locca', 'bin', 'llama-cpp');

export type Backend = 'vulkan' | 'cuda' | 'hip' | 'metal' | 'cpu';
export type Platform = 'linux' | 'macos' | 'windows';
export type Arch = 'x64' | 'arm64';

export interface PlatformInfo {
  platform: Platform;
  arch: Arch;
}

export interface BackendChoice {
  backend: Backend;
  /** One-line "why we're suggesting this" hint for the picker. */
  reason: string;
}

export interface ReleaseAsset {
  name: string;
  /** GitHub-issued download URL. */
  browser_download_url: string;
  size: number;
}

export interface Release {
  /** e.g. "b6814". */
  tag_name: string;
  /** Human label, often same as tag. */
  name: string;
  assets: ReleaseAsset[];
  html_url: string;
}

export interface Installed {
  dir: string;
  serverPath: string;
  cliPath: string;
  benchPath: string;
  version: string;
  backend: Backend;
}

/** Resolve the current host into a (platform, arch) pair install assets are keyed on. */
export function detectPlatform(): PlatformInfo {
  const platform: Platform =
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { platform, arch };
}

/**
 * Suggest a backend based on what we can see about the host. We're never
 * 100% sure (vulkaninfo can lie, an iGPU can be on the bus without a
 * usable driver), so this is a "default for the picker" — the user can
 * override.
 */
export function suggestBackend(plat: PlatformInfo = detectPlatform()): BackendChoice {
  if (plat.platform === 'macos') {
    return { backend: 'metal', reason: 'macOS — Metal is the only sensible choice' };
  }
  const hw = probeHardware();
  const hasNvidia = hw.gpus.some((g) => g.vendor === 'nvidia');
  const hasAmd = hw.gpus.some((g) => g.vendor === 'amd');
  const hasIntel = hw.gpus.some((g) => g.vendor === 'intel');

  if (hasNvidia) {
    // Upstream only ships CUDA prebuilts for Windows. On Linux, NVIDIA users
    // get vulkan via NVIDIA's open driver (works fine for inference) or build
    // CUDA from source. Suggesting cuda for linux/nvidia is a dead-end.
    if (plat.platform === 'linux') {
      return {
        backend: 'vulkan',
        reason: 'NVIDIA GPU on Linux — upstream has no CUDA prebuilt, Vulkan works',
      };
    }
    return { backend: 'cuda', reason: 'NVIDIA GPU detected' };
  }
  if (hasAmd || hasIntel) {
    return {
      backend: 'vulkan',
      reason: `${hasAmd ? 'AMD' : 'Intel'} GPU detected — Vulkan works on iGPU + dGPU`,
    };
  }
  return { backend: 'cpu', reason: 'no GPU detected — CPU build' };
}

export function backendOptions(plat: PlatformInfo = detectPlatform()): Backend[] {
  if (plat.platform === 'macos') return ['metal', 'cpu'];
  return ['vulkan', 'cuda', 'hip', 'cpu'];
}

/** Fetch the latest release metadata from the llama.cpp GitHub repo. */
export async function fetchLatestRelease(): Promise<Release> {
  const r = await fetch(`https://api.github.com/repos/${LLAMA_REPO}/releases/latest`, {
    headers: {
      'User-Agent': 'locca-cli',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!r.ok) {
    throw new Error(`GitHub releases API ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as Release;
}

/**
 * Pick the asset whose name matches our (platform, arch, backend) tuple.
 * llama.cpp asset naming convention has been stable since ~b3000 but does
 * occasionally drift (e.g. "ubuntu" vs "linux"), so we match defensively.
 */
export function pickAsset(
  release: Release,
  plat: PlatformInfo,
  backend: Backend,
): ReleaseAsset | undefined {
  const assets = release.assets;

  const tokens = (s: string) => s.toLowerCase();
  const has = (name: string, ...needles: string[]) =>
    needles.every((n) => tokens(name).includes(n));
  const hasAny = (name: string, ...needles: string[]) =>
    needles.some((n) => tokens(name).includes(n));

  // Drop the standalone CUDA runtime archives (cudart-...zip). Upstream
  // ships these alongside the main builds for users compiling with cuda;
  // they don't contain llama-server.
  const main = assets.filter((a) => !tokens(a.name).startsWith('cudart-'));

  // Filter to the right (platform, arch). llama.cpp uses "ubuntu" for linux
  // builds and either "x64" or "x86_64" depending on the era.
  const platMatchers: Record<Platform, (n: string) => boolean> = {
    linux: (n) =>
      hasAny(n, 'ubuntu', 'linux') &&
      (plat.arch === 'arm64' ? hasAny(n, 'arm64', 'aarch64') : hasAny(n, 'x64', 'x86_64', 'amd64')),
    macos: (n) => has(n, 'macos') && hasAny(n, plat.arch === 'arm64' ? 'arm64' : 'x64'),
    windows: (n) =>
      hasAny(n, 'win', 'windows') &&
      (plat.arch === 'arm64' ? hasAny(n, 'arm64', 'aarch64') : hasAny(n, 'x64', 'x86_64', 'amd64')),
  };

  const platMatching = main.filter((a) => platMatchers[plat.platform](a.name));

  // Tags for any "specialty" backend — used to identify a vanilla CPU
  // build by exclusion. Without this filter the CPU matcher would happily
  // pick up an OpenVINO / SYCL / KleidiAI archive that happens to have no
  // explicit "gpu" tag in our short list.
  const specialtyTags = [
    'vulkan',
    'cuda',
    'hip',
    'rocm',
    'metal',
    'opencl',
    'openvino',
    'sycl',
    'kleidiai',
    'aclgraph',
  ];

  const backendMatchers: Record<Backend, (n: string) => boolean> = {
    vulkan: (n) => has(n, 'vulkan'),
    cuda: (n) => has(n, 'cuda'),
    hip: (n) => hasAny(n, 'hip', 'rocm'),
    metal: (n) => !specialtyTags.some((t) => has(n, t)),
    cpu: (n) => !specialtyTags.some((t) => has(n, t)),
  };

  const matched = platMatching.filter((a) => backendMatchers[backend](a.name));
  if (matched.length === 0) return undefined;

  // If multiple match (e.g. CUDA 11.7 + 12.4), prefer the highest-numbered
  // CUDA — newer drivers cover older runtimes via forward compat.
  matched.sort((a, b) => extractCudaVersion(b.name) - extractCudaVersion(a.name));
  return matched[0];
}

function extractCudaVersion(name: string): number {
  const m = name.match(/cuda[-_]?(\d+)(?:[.\-_](\d+))?/i);
  if (!m) return 0;
  const major = parseInt(m[1] ?? '0', 10);
  const minor = parseInt(m[2] ?? '0', 10);
  return major * 100 + minor;
}

/**
 * Download a release asset into ~/.locca/bin/llama-cpp/<build>-<backend>/,
 * extract it, and return the resolved binary paths. Skips the download if
 * the destination already exists with a working llama-server.
 */
export async function downloadAndExtract(opts: {
  release: Release;
  asset: ReleaseAsset;
  backend: Backend;
  onProgress?: (got: number, total: number) => void;
}): Promise<Installed> {
  const { release, asset, backend, onProgress } = opts;
  mkdirSync(LLAMA_BIN_DIR, { recursive: true });

  const dirName = `${release.tag_name}-${backend}`;
  const installDir = join(LLAMA_BIN_DIR, dirName);

  // Existing-install short-circuit. If the user re-runs install-llama
  // pointing at the same version+backend, just reuse the existing dir.
  const existing = locateBinaries(installDir);
  if (existing && verifyBinary(existing.serverPath)) {
    return {
      dir: installDir,
      serverPath: existing.serverPath,
      cliPath: existing.cliPath,
      benchPath: existing.benchPath,
      version: release.tag_name,
      backend,
    };
  }

  // Fresh install: download to a temp file in case of a network failure
  // mid-stream, then move into place once extraction succeeds.
  const tmpArchive = join(LLAMA_BIN_DIR, `.${dirName}.${process.pid}.download`);
  const stagingDir = join(LLAMA_BIN_DIR, `.${dirName}.${process.pid}.staging`);
  rmSync(tmpArchive, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });

  try {
    await downloadFile(asset.browser_download_url, tmpArchive, onProgress);
    mkdirSync(stagingDir, { recursive: true });
    extractArchive(tmpArchive, stagingDir);

    // Some archives put binaries directly under the staging dir; others
    // have a top-level folder (`build/bin/...`). Find them.
    const located = locateBinaries(stagingDir);
    if (!located) {
      throw new Error(
        `Extracted archive but could not find llama-server in ${stagingDir}. The release layout may have changed — file an issue.`,
      );
    }

    if (process.platform === 'darwin') {
      // Strip Gatekeeper quarantine so the user doesn't hit "cannot be
      // opened because the developer cannot be verified" on first run.
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', stagingDir], {
        stdio: 'ignore',
      });
    }

    rmSync(installDir, { recursive: true, force: true });
    // Move staging into the canonical install dir so a partial extract
    // never leaves a half-installed dir on disk under the real name.
    moveOrCopy(stagingDir, installDir);

    const final = locateBinaries(installDir);
    if (!final) {
      throw new Error(`Install layout broke after rename: ${installDir}`);
    }
    if (!verifyBinary(final.serverPath)) {
      throw new Error(
        `Installed llama-server but it failed --version. Check ${installDir} or try a different backend.`,
      );
    }

    return {
      dir: installDir,
      serverPath: final.serverPath,
      cliPath: final.cliPath,
      benchPath: final.benchPath,
      version: release.tag_name,
      backend,
    };
  } finally {
    rmSync(tmpArchive, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Recursively look for llama-server, llama-cli, llama-bench under root.
 * Returns null if llama-server isn't found — the others are best-effort.
 */
export function locateBinaries(root: string): {
  serverPath: string;
  cliPath: string;
  benchPath: string;
} | null {
  if (!existsSync(root)) return null;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const targets = {
    server: `llama-server${exe}`,
    cli: `llama-cli${exe}`,
    bench: `llama-bench${exe}`,
  };

  const found: Record<keyof typeof targets, string | undefined> = {
    server: undefined,
    cli: undefined,
    bench: undefined,
  };

  // BFS up to a sane depth so we don't run forever on a pathological tree.
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(path, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) queue.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (e === targets.server && !found.server) found.server = full;
      else if (e === targets.cli && !found.cli) found.cli = full;
      else if (e === targets.bench && !found.bench) found.bench = full;
    }
  }
  if (!found.server) return null;
  // Fall back to the server's directory for cli/bench when missing — the
  // upstream archive ships them together so this should rarely fire.
  const dir = dirname(found.server);
  return {
    serverPath: found.server,
    cliPath: found.cli ?? join(dir, targets.cli),
    benchPath: found.bench ?? join(dir, targets.bench),
  };
}

export function verifyBinary(serverPath: string): boolean {
  if (!existsSync(serverPath)) return false;
  // Metal init on Apple Silicon can take 10+ seconds on first run before
  // --version prints anything — give the probe plenty of headroom.
  const r = spawnSync(serverPath, ['--version'], { encoding: 'utf8', timeout: 30000 });
  // llama-server prints version to stderr and exits 0 or 1 — both are fine
  // as long as we got *some* version string out.
  const out = (r.stderr || r.stdout || '').toLowerCase();
  return out.includes('version') || out.includes('build');
}

/** Remove a previously-installed bundled llama.cpp directory. */
export function removeInstall(dir: string): void {
  if (!dir.startsWith(LLAMA_BIN_DIR)) {
    // Refuse to remove anything outside our managed dir.
    throw new Error(`Refusing to remove path outside ~/.locca/bin: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Prune locca-managed install dirs other than `keep`. Best-effort. */
export function pruneOldInstalls(keep: string): void {
  if (!existsSync(LLAMA_BIN_DIR)) return;
  for (const entry of readdirSync(LLAMA_BIN_DIR)) {
    const full = join(LLAMA_BIN_DIR, entry);
    if (full === keep) continue;
    if (entry.startsWith('.')) continue; // skip our staging temp dirs
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      // ignore — best-effort cleanup
    }
  }
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (got: number, total: number) => void,
): Promise<void> {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) {
    throw new Error(`Download failed: ${r.status} ${r.statusText}`);
  }
  const total = parseInt(r.headers.get('content-length') ?? '0', 10);
  const out = createWriteStream(dest);
  let got = 0;

  const body = Readable.fromWeb(r.body as never);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    onProgress?.(got, total);
  });
  await pipeline(body, out);
}

/**
 * Extract a release archive into `dest`. Tries `unzip` first (zip is what
 * llama.cpp publishes), then falls back to `tar -xf` which on Linux/macOS
 * via libarchive can also handle zip — and on Windows 10+ tar is built in.
 */
function extractArchive(archive: string, dest: string): void {
  const lower = archive.toLowerCase();
  const isZip = lower.endsWith('.zip');
  const isTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.xz');

  if (isZip) {
    if (tryExtract('unzip', ['-q', '-o', archive, '-d', dest])) return;
    if (tryExtract('tar', ['-xf', archive, '-C', dest])) return;
    throw new Error(
      'Could not extract zip — neither `unzip` nor `tar` worked. Install one or extract manually.',
    );
  }
  if (isTar) {
    if (tryExtract('tar', ['-xf', archive, '-C', dest])) return;
    throw new Error('Could not extract tar archive — `tar` is required.');
  }
  // Unknown extension — best effort with tar (libarchive sniffs format).
  if (tryExtract('tar', ['-xf', archive, '-C', dest])) return;
  throw new Error(`Unknown archive format: ${archive}`);
}

function tryExtract(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Move src to dest. Prefers fs.renameSync (atomic on same filesystem); falls
 * back to recursive copy when the rename crosses devices (e.g. /tmp on tmpfs
 * vs ~/.locca on the home partition).
 */
function moveOrCopy(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch {
    // EXDEV (cross-device) or EEXIST — copy then remove.
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** Path used by docs / doctor to point users at the version on disk. */
export function bundledRoot(): string {
  return LLAMA_BIN_DIR;
}

/**
 * Convenience wrapper used by the wizard and standalone command.
 * Returns the installed binaries on success; throws on failure.
 */
export async function installLlama(opts: {
  backend: Backend;
  onProgress?: (got: number, total: number) => void;
  release?: Release;
}): Promise<Installed> {
  const plat = detectPlatform();
  const release = opts.release ?? (await fetchLatestRelease());
  const asset = pickAsset(release, plat, opts.backend);
  if (!asset) {
    const distro = detectDistro();
    throw new Error(
      `No prebuilt ${opts.backend} binary for ${plat.platform}/${plat.arch} in release ${release.tag_name}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(', ')}. ` +
        `You may need to install llama.cpp manually for ${distro.prettyName}.`,
    );
  }
  return downloadAndExtract({
    release,
    asset,
    backend: opts.backend,
    onProgress: opts.onProgress,
  });
}
