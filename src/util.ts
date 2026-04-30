import { statSync } from 'node:fs';
import { cpus, homedir, networkInterfaces } from 'node:os';
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

export interface ExternalAddresses {
  lan: string[];
  tailscale: string[];
}

/**
 * Enumerate the host's non-loopback IPv4 addresses, classifying each as
 * either a LAN address or a Tailscale address. Useful for showing "also
 * reachable at" URLs when the llama-server binds 0.0.0.0.
 *
 * Tailscale detection: interface name (`tailscale*`) on Linux/Windows, plus
 * the 100.64.0.0/10 CGNAT range that catches macOS's `utunN` interfaces.
 *
 * Skipped: container-bridge and virtual interfaces (docker0, podman, lxc,
 * br-*, veth*, virbr*, vmnet*, wg* …) — these aren't reachable from
 * outside the host so advertising their IPs as LAN URLs would confuse.
 */
export function networkAddresses(): ExternalAddresses {
  const skip = /^(docker|br-|podman|veth|cni|virbr|flannel|vmnet|lxc|lxdbr|wg)/;
  const lan: string[] = [];
  const tailscale: string[] = [];

  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!addrs || skip.test(name)) continue;
    for (const a of addrs) {
      if (a.internal || a.family !== 'IPv4') continue;
      const [o1, o2] = a.address.split('.').map(Number);
      const isCgnat = o1 === 100 && (o2 ?? 0) >= 64 && (o2 ?? 0) <= 127;
      const isTailscale = name.startsWith('tailscale') || isCgnat;
      if (isTailscale) tailscale.push(a.address);
      else lan.push(a.address);
    }
  }

  return {
    lan: [...new Set(lan)],
    tailscale: [...new Set(tailscale)],
  };
}
