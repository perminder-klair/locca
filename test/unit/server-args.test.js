import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServerArgs } from '../../dist/server.js';

const base = {
  llamaServer: 'llama-server',
  modelPath: '/models/foo.gguf',
  port: 8080,
  ctx: 32768,
  threads: 8,
};

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('chat args include the tuned common flags', () => {
  const args = buildServerArgs(base);
  assert.equal(flagValue(args, '--model'), '/models/foo.gguf');
  assert.equal(flagValue(args, '--port'), '8080');
  assert.equal(flagValue(args, '--host'), '0.0.0.0');
  assert.equal(flagValue(args, '--ctx-size'), '32768');
  assert.ok(args.includes('--jinja'));
  assert.equal(flagValue(args, '--parallel'), '1');
});

test('chat args honour host, parallel, mmproj, and no-mmap', () => {
  const args = buildServerArgs({
    ...base,
    host: '127.0.0.1',
    parallel: 4,
    mmprojPath: '/models/mmproj.gguf',
    noMmap: true,
  });
  assert.equal(flagValue(args, '--host'), '127.0.0.1');
  assert.equal(flagValue(args, '--parallel'), '4');
  assert.equal(flagValue(args, '--mmproj'), '/models/mmproj.gguf');
  assert.ok(args.includes('--no-mmap'));
});

test('bad parallel values fall back to 1', () => {
  assert.equal(flagValue(buildServerArgs({ ...base, parallel: 0 }), '--parallel'), '1');
  assert.equal(flagValue(buildServerArgs({ ...base, parallel: -3 }), '--parallel'), '1');
  assert.equal(flagValue(buildServerArgs({ ...base, parallel: 1.5 }), '--parallel'), '1');
});

test('embedding mode swaps in encoder flags and drops chat flags', () => {
  const args = buildServerArgs({ ...base, mode: 'embedding', ctx: 8192 });
  assert.ok(args.includes('--embeddings'));
  assert.equal(flagValue(args, '--pooling'), 'mean');
  assert.equal(flagValue(args, '--ubatch-size'), '8192');
  assert.equal(flagValue(args, '--batch-size'), '8192');
  assert.ok(!args.includes('--jinja'));
  assert.ok(!args.includes('--parallel'));
});

test('extraArgs are appended last so they override common flags', () => {
  const args = buildServerArgs({ ...base, extraArgs: ['--temp', '0.6'] });
  assert.equal(args[args.length - 2], '--temp');
  assert.equal(args[args.length - 1], '0.6');
});
