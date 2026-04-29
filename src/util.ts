import { statSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';

export function autoThreads(): number {
  const n = cpus().length;
  return n > 2 ? n - 2 : 1;
}

export function have(cmd: string): boolean {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      const full = join(dir, cmd);
      const s = statSync(full);
      if (s.isFile() && (s.mode & 0o111) !== 0) return true;
    } catch {
      // not in this dir
    }
  }
  return false;
}

export function which(cmd: string): string | null {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      const full = join(dir, cmd);
      const s = statSync(full);
      if (s.isFile() && (s.mode & 0o111) !== 0) return full;
    } catch {
      // not in this dir
    }
  }
  return null;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function formatGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

export function formatMB(bytes: number): string {
  return Math.round(bytes / 1024 / 1024).toString();
}
