import { closeSync, openSync, readSync } from 'node:fs';

export interface GgufHeader {
  version: number;
  nTensors: bigint;
  nKv: bigint;
}

/**
 * Read just the GGUF magic + version + counts (24 bytes).
 * Replaces the inline python3 in the bash version.
 */
export function readGgufHeader(path: string): GgufHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(24);
    readSync(fd, buf, 0, 24, 0);
    if (buf.toString('ascii', 0, 4) !== 'GGUF') return null;
    return {
      version: buf.readUInt32LE(4),
      nTensors: buf.readBigUInt64LE(8),
      nKv: buf.readBigUInt64LE(16),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
