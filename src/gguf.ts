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

/**
 * GGUF metadata value type tags (gguf.h `gguf_type`). Used to skip over the
 * metadata KV block so we can reach the tensor-info section.
 */
const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

/**
 * On-demand, chunk-buffered reader over a file descriptor. GGUF metadata can
 * carry multi-MB string arrays (tokenizer vocab), so a one-shot read is both
 * wasteful and unbounded — this refills a 1 MiB window as the cursor advances.
 */
class GgufCursor {
  private static readonly CHUNK = 1 << 20;
  private chunk: Buffer = Buffer.alloc(0);
  private off = 0;
  private abs = 0;

  constructor(private readonly fd: number) {}

  private ensure(n: number): void {
    if (this.off + n <= this.chunk.length) return;
    const start = this.abs + this.off;
    const size = Math.max(n, GgufCursor.CHUNK);
    const b = Buffer.alloc(size);
    const got = readSync(this.fd, b, 0, size, start);
    if (got < n) throw new Error('unexpected eof');
    this.chunk = b.subarray(0, got);
    this.abs = start;
    this.off = 0;
  }

  bytes(n: number): Buffer {
    this.ensure(n);
    const out = this.chunk.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  skip(n: number): void {
    if (this.off + n <= this.chunk.length) {
      this.off += n;
      return;
    }
    // Jump past the current window; next ensure() refills from the new position.
    this.abs = this.abs + this.off + n;
    this.off = 0;
    this.chunk = Buffer.alloc(0);
  }

  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }

  /** GGUF counts/lengths comfortably fit in a JS number (< 2^53). */
  u64(): number {
    return Number(this.bytes(8).readBigUInt64LE(0));
  }

  str(): string {
    const len = this.u64();
    return this.bytes(len).toString('utf8');
  }
}

/** Skip a value of the given gguf_type without materialising it. */
function skipGgufValue(c: GgufCursor, type: number): void {
  switch (type) {
    case GGUF_TYPE.UINT8:
    case GGUF_TYPE.INT8:
    case GGUF_TYPE.BOOL:
      c.skip(1);
      return;
    case GGUF_TYPE.UINT16:
    case GGUF_TYPE.INT16:
      c.skip(2);
      return;
    case GGUF_TYPE.UINT32:
    case GGUF_TYPE.INT32:
    case GGUF_TYPE.FLOAT32:
      c.skip(4);
      return;
    case GGUF_TYPE.UINT64:
    case GGUF_TYPE.INT64:
    case GGUF_TYPE.FLOAT64:
      c.skip(8);
      return;
    case GGUF_TYPE.STRING:
      c.skip(c.u64());
      return;
    case GGUF_TYPE.ARRAY: {
      const elemType = c.u32();
      const count = c.u64();
      for (let i = 0; i < count; i++) skipGgufValue(c, elemType);
      return;
    }
    default:
      throw new Error(`unknown gguf type ${type}`);
  }
}

/**
 * Multi-Token-Prediction / NextN draft heads ship as extra tensors whose names
 * carry an `nextn` (or `mtp`) marker — e.g. `blk.48.nextn.embed_tokens.weight`.
 * llama.cpp's `--spec-type draft-mtp` only works when the GGUF actually
 * contains these; a name like "Qwen 3.6" is not sufficient. Sniffing tensor
 * names is the authoritative test.
 */
const MTP_TENSOR_RE = /(?:^|[._])(?:nextn|mtp)(?:[._]|$)/i;

/**
 * True iff the GGUF at `path` contains Multi-Token-Prediction head tensors.
 * Parses past the 24-byte header: skips the metadata KV block, then scans
 * tensor-info names. Defensive — returns `false` on any parse/IO error or on
 * a GGUF version old enough to predate the current layout.
 */
export function ggufHasMtpHead(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const c = new GgufCursor(fd);

    if (c.bytes(4).toString('ascii') !== 'GGUF') return false;
    const version = c.u32();
    // v1 used 32-bit counts and a different layout; only v2+ is parsed here.
    if (version < 2) return false;
    const nTensors = c.u64();
    const nKv = c.u64();

    // Skip the metadata KV block: each entry is key-string + typed value.
    for (let i = 0; i < nKv; i++) {
      c.str();
      skipGgufValue(c, c.u32());
    }

    // Tensor info: name, n_dims, dims[n_dims] (u64), ggml_type (u32), offset (u64).
    for (let i = 0; i < nTensors; i++) {
      const name = c.str();
      if (MTP_TENSOR_RE.test(name)) return true;
      const nDims = c.u32();
      c.skip(nDims * 8);
      c.skip(4); // ggml_type
      c.skip(8); // offset
    }
    return false;
  } catch {
    return false;
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
