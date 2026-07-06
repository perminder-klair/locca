import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeHfPath, parseRepo } from '../../dist/hf.js';
import { parseDuration } from '../../dist/proxy.js';

test('parseDuration accepts s/m/h suffixes and bare seconds', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('15m'), 900);
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration(' 45S '), 45);
});

test('parseDuration rejects junk and non-positive values', () => {
  assert.equal(parseDuration('0'), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('5x'), null);
  assert.equal(parseDuration('-10s'), null);
  assert.equal(parseDuration(''), null);
});

test('parseRepo strips HF URLs and trailing slashes', () => {
  assert.equal(parseRepo('unsloth/Qwen3.6-GGUF'), 'unsloth/Qwen3.6-GGUF');
  assert.equal(parseRepo('https://huggingface.co/unsloth/Qwen3.6-GGUF'), 'unsloth/Qwen3.6-GGUF');
  assert.equal(parseRepo('https://huggingface.co/unsloth/Qwen3.6-GGUF///'), 'unsloth/Qwen3.6-GGUF');
  assert.equal(parseRepo('  qwen  '), 'qwen');
});

test('encodeHfPath keeps directory separators but encodes segments', () => {
  assert.equal(encodeHfPath('model.gguf'), 'model.gguf');
  assert.equal(
    encodeHfPath('UD-Q4_K_XL/model-00001-of-00002.gguf'),
    'UD-Q4_K_XL/model-00001-of-00002.gguf',
  );
  assert.equal(encodeHfPath('dir with space/a#b.gguf'), 'dir%20with%20space/a%23b.gguf');
});
