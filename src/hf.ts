import { createWriteStream } from 'node:fs';
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

export async function listFiles(repo: string): Promise<string[]> {
  const r = await fetch(`${HF}/api/models/${encodeURI(repo)}`);
  if (!r.ok) throw new Error(`HF API ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as { siblings?: Array<{ rfilename?: string }> };
  return (data.siblings ?? []).map((s) => s.rfilename).filter((s): s is string => Boolean(s));
}

export async function fileSize(repo: string, file: string): Promise<number | null> {
  try {
    const r = await fetch(`${HF}/${repo}/resolve/main/${encodeURIComponent(file)}`, {
      method: 'HEAD',
      redirect: 'follow',
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
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = (await r.json()) as Array<{ id: string; downloads?: number; likes?: number }>;
  return data.map((m) => ({
    id: m.id,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
  }));
}

export async function downloadFile(
  repo: string,
  file: string,
  dest: string,
  onProgress?: (got: number, total: number) => void,
): Promise<void> {
  const r = await fetch(`${HF}/${repo}/resolve/main/${encodeURIComponent(file)}`, {
    redirect: 'follow',
  });
  if (!r.ok || !r.body) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
  const total = parseInt(r.headers.get('content-length') ?? '0', 10);

  const out = createWriteStream(dest);
  let got = 0;

  // Wrap the web ReadableStream as a Node Readable, intercept chunks for progress.
  const body = Readable.fromWeb(r.body as never);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    onProgress?.(got, total);
  });

  await pipeline(body, out);
}
