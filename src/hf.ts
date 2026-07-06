import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, renameSync, statSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HF = 'https://huggingface.co';

export interface HFFile {
  rfilename: string;
  size?: number;
}

export interface HFSearchResult {
  id: string;
  downloads: number;
  likes: number;
}

export function parseRepo(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (s.startsWith('https://huggingface.co/')) {
    s = s.slice('https://huggingface.co/'.length);
  }
  return s;
}

/**
 * Encode an HF file path for a `/resolve/main/<path>` URL. Encodes each
 * segment but keeps the `/` separators — `encodeURIComponent` on the whole
 * path would turn `UD-Q4_K_XL/model-00001.gguf` into `...%2F...`, which the
 * resolve endpoint doesn't route. Subfoldered GGUFs (sharded / UD quants)
 * are common, so this matters.
 */
export function encodeHfPath(file: string): string {
  return file.split('/').map(encodeURIComponent).join('/');
}

/**
 * Optional HF auth for gated/private repos (Llama, Gemma, …). Reads the same
 * env vars the huggingface_hub tooling uses. Anonymous access keeps working
 * for public repos when unset.
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  return { ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

export async function listFiles(repo: string): Promise<string[]> {
  const r = await fetch(`${HF}/api/models/${encodeURI(repo)}`, { headers: authHeaders() });
  if (!r.ok) {
    // HF returns a misleading 401 "Invalid username or password" for both
    // malformed ids (no slash) AND non-existent repos when unauthenticated.
    // Translate so users don't go hunting for a login they don't need.
    const body = await r.text();
    if (r.status === 401 || r.status === 404) {
      if (!repo.includes('/')) {
        throw new Error(
          `'${repo}' isn't a valid repo id — need org/name (e.g. unsloth/Qwen3.6-35B-A3B-GGUF). Try \`locca search ${repo}\`.`,
        );
      }
      throw new Error(
        `repo '${repo}' not found on HuggingFace (or is gated/private — set HF_TOKEN for gated repos). Check the spelling, or try \`locca search ${repo.split('/').pop()}\`.`,
      );
    }
    throw new Error(`HF API ${r.status}: ${body}`);
  }
  const data = (await r.json()) as { siblings?: Array<{ rfilename?: string }> };
  return (data.siblings ?? []).map((s) => s.rfilename).filter((s): s is string => Boolean(s));
}

export async function fileSize(repo: string, file: string): Promise<number | null> {
  try {
    const r = await fetch(`${HF}/${repo}/resolve/main/${encodeHfPath(file)}`, {
      method: 'HEAD',
      redirect: 'follow',
      headers: authHeaders(),
    });
    if (!r.ok) return null;
    const len = r.headers.get('content-length');
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

export async function searchModels(query: string): Promise<HFSearchResult[]> {
  const url = new URL(`${HF}/api/models`);
  url.searchParams.set('search', query);
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', '15');
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) return [];
  const data = (await r.json()) as Array<{ id: string; downloads?: number; likes?: number }>;
  return data.map((m) => ({
    id: m.id,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
  }));
}

/**
 * Expected sha256 of a repo file, from HF's paths-info API (LFS files carry
 * their content hash as the LFS oid). Null when the API doesn't answer or the
 * file isn't LFS — callers should treat that as "can't verify", not an error.
 */
export async function fileSha256(repo: string, file: string): Promise<string | null> {
  try {
    const r = await fetch(`${HF}/api/models/${encodeURI(repo)}/paths-info/main`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ paths: [file] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as Array<{ path?: string; lfs?: { oid?: string } }>;
    return data.find((e) => e.path === file)?.lfs?.oid ?? null;
  } catch {
    return null;
  }
}

/** Streaming sha256 of a local file (hex). These files are tens of GB —
 *  never buffer them. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Download a HuggingFace repo file to `dest` atomically and resumably.
 * Thin wrapper over `downloadUrl` that builds the resolve URL.
 */
export async function downloadFile(
  repo: string,
  file: string,
  dest: string,
  onProgress?: (got: number, total: number) => void,
): Promise<void> {
  return downloadUrl(`${HF}/${repo}/resolve/main/${encodeHfPath(file)}`, dest, onProgress);
}

/**
 * Download `url` to `dest` atomically and resumably.
 *
 * Streams into `dest + '.part'` and renames on success, so an interrupted
 * download never leaves a truncated `.gguf` where `scanModels()` would pick
 * it up. A leftover `.part` is resumed with a `Range` request on the next
 * attempt — these files are tens of GB, restarting from zero is brutal.
 *
 * Received bytes are checked against the advertised total before the rename;
 * a short read throws instead of publishing a corrupt file.
 */
export async function downloadUrl(
  url: string,
  dest: string,
  onProgress?: (got: number, total: number) => void,
): Promise<void> {
  const part = `${dest}.part`;

  let offset = 0;
  try {
    offset = statSync(part).size;
  } catch {
    // no partial file — fresh download
  }

  let r = await fetch(url, {
    redirect: 'follow',
    headers: authHeaders(offset > 0 ? { range: `bytes=${offset}-` } : undefined),
  });

  if (r.status === 416) {
    // Range not satisfiable: offset >= file size. If the .part is exactly the
    // full file (a previous run died between writing and renaming), publish
    // it; anything else is garbage — start over.
    const m = r.headers.get('content-range')?.match(/\/(\d+)\s*$/);
    if (m && offset === parseInt(m[1]!, 10)) {
      renameSync(part, dest);
      return;
    }
    unlinkSync(part);
    offset = 0;
    r = await fetch(url, { redirect: 'follow', headers: authHeaders() });
  }

  if (!r.ok || !r.body) throw new Error(`Download failed: ${r.status} ${r.statusText}`);

  // Only a 206 actually honoured the Range — a 200 means the server (or a
  // redirect hop) ignored it and is sending the whole file from byte 0.
  const resuming = offset > 0 && r.status === 206;
  if (!resuming) offset = 0;

  const remaining = parseInt(r.headers.get('content-length') ?? '0', 10);
  const total = remaining > 0 ? offset + remaining : 0;

  const out = createWriteStream(part, resuming ? { flags: 'a' } : undefined);
  let got = offset;

  // Wrap the web ReadableStream as a Node Readable, intercept chunks for progress.
  const body = Readable.fromWeb(r.body as never);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    onProgress?.(got, total);
  });

  await pipeline(body, out);

  if (total > 0) {
    const onDisk = statSync(part).size;
    if (onDisk !== total) {
      throw new Error(
        `incomplete download: got ${onDisk} of ${total} bytes — run the download again to resume`,
      );
    }
  }
  renameSync(part, dest);
}
