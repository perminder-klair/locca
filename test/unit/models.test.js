import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ctxCapForBudget, ctxForModel, findFirstMatch, findMatches } from '../../dist/models.js';

const model = (name) => ({
  name,
  path: `/models/${name}.gguf`,
  dir: '/models',
  sizeBytes: 0,
  sizeGB: 0,
  hasVision: false,
});

const models = [
  model('qwen-7b'),
  model('qwen-7b-instruct'),
  model('gemma-4-E2B-it-UD-Q4_K_XL'),
];

test('findMatches prefers an exact name match over substring hits', () => {
  const m = findMatches(models, 'qwen-7b');
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'qwen-7b');
});

test('findMatches falls back to substring and reports all hits', () => {
  const m = findMatches(models, 'qwen');
  assert.equal(m.length, 2);
});

test('findFirstMatch strips a trailing .gguf from the pattern', () => {
  const m = findFirstMatch(models, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf');
  assert.equal(m?.name, 'gemma-4-E2B-it-UD-Q4_K_XL');
});

test('findFirstMatch returns null for no match', () => {
  assert.equal(findFirstMatch(models, 'nope'), null);
});

// Regex-by-name heuristic (non-catalog names). Order matters in the source —
// these pin the size-class boundaries and the lookaround anchors.
test('ctxForModel size classes', () => {
  assert.equal(ctxForModel('MyDense-32B-Q4_K_M'), 65536);
  assert.equal(ctxForModel('Chunky-27B-it'), 32768);
  assert.equal(ctxForModel('Middle-14B'), 65536);
  assert.equal(ctxForModel('Tiny-9B-test'), 131072); // 9B must not match 32B branches
  assert.equal(ctxForModel('SomeMoE-A3B-thing'), 131072);
  assert.equal(ctxForModel('CompletelyUnknownModel'), 32768);
});

test('ctxForModel honours the vram budget cap', () => {
  assert.equal(ctxForModel('Tiny-9B-test', 6 * 1024), 8192);
  assert.equal(ctxForModel('MyDense-32B-Q4_K_M', 8 * 1024), 16384);
});

test('ctxCapForBudget tiers', () => {
  assert.equal(ctxCapForBudget(undefined), undefined);
  assert.equal(ctxCapForBudget(0), undefined);
  assert.equal(ctxCapForBudget(6 * 1024), 8192);
  assert.equal(ctxCapForBudget(8 * 1024), 16384);
  assert.equal(ctxCapForBudget(12 * 1024), 32768);
  assert.equal(ctxCapForBudget(16 * 1024), 65536);
  assert.equal(ctxCapForBudget(24 * 1024), 131072);
});
