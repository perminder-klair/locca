import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ggufHasMtpHead, readGgufHeader } from '../../dist/gguf.js';

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(b.length), b]);
};

// GGUF_TYPE.STRING = 8, GGUF_TYPE.ARRAY = 9, GGUF_TYPE.UINT32 = 4
const kvString = (key, value) => Buffer.concat([str(key), u32(8), str(value)]);
const kvU32Array = (key, values) =>
  Buffer.concat([str(key), u32(9), u32(4), u64(values.length), ...values.map(u32)]);

const tensorInfo = (name) =>
  Buffer.concat([
    str(name),
    u32(1), // n_dims
    u64(64), // dims[0]
    u32(0), // ggml_type
    u64(0), // offset
  ]);

/** Minimal syntactically-valid GGUF v3 file: metadata KVs + tensor infos. */
function makeGguf(tensorNames, kvs = []) {
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(tensorNames.length),
    u64(kvs.length),
    ...kvs,
    ...tensorNames.map(tensorInfo),
  ]);
}

function writeTmp(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'locca-gguf-'));
  const p = join(dir, 'test.gguf');
  writeFileSync(p, buf);
  return p;
}

test('readGgufHeader parses magic, version, and counts', () => {
  const p = writeTmp(makeGguf(['blk.0.attn.weight'], [kvString('general.name', 'test')]));
  const h = readGgufHeader(p);
  assert.ok(h);
  assert.equal(h.version, 3);
  assert.equal(h.nTensors, 1n);
  assert.equal(h.nKv, 1n);
});

test('readGgufHeader returns null for non-GGUF files', () => {
  const p = writeTmp(Buffer.from('definitely not a gguf file at all'));
  assert.equal(readGgufHeader(p), null);
});

test('ggufHasMtpHead detects nextn tensors past the KV block', () => {
  const kvs = [
    kvString('general.name', 'mtp-model'),
    kvU32Array('some.array', [1, 2, 3]),
  ];
  const withMtp = writeTmp(
    makeGguf(['blk.0.attn.weight', 'blk.48.nextn.embed_tokens.weight'], kvs),
  );
  assert.equal(ggufHasMtpHead(withMtp), true);
});

test('ggufHasMtpHead is false without MTP tensors and on junk input', () => {
  const without = writeTmp(makeGguf(['blk.0.attn.weight', 'output.weight']));
  assert.equal(ggufHasMtpHead(without), false);
  // "nextnothing" must not match — the marker needs its own [._] boundaries
  const nearMiss = writeTmp(makeGguf(['blk.0.nextnothing.weight']));
  assert.equal(ggufHasMtpHead(nearMiss), false);
  const junk = writeTmp(Buffer.from('not gguf'));
  assert.equal(ggufHasMtpHead(junk), false);
});
