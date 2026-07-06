import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommonServeFlags } from '../../dist/flags.js';

test('parses pattern + common flags in both forms', () => {
  const f = parseCommonServeFlags([
    'qwen',
    '--port',
    '9090',
    '--ctx=16384',
    '--threads',
    '6',
    '--host=127.0.0.1',
    '--api-key',
    'secret',
    '-y',
  ]);
  assert.deepEqual(f, {
    pattern: 'qwen',
    port: 9090,
    ctx: 16384,
    threads: 6,
    host: '127.0.0.1',
    apiKey: 'secret',
    yes: true,
  });
});

test('defaults are empty with yes=false', () => {
  assert.deepEqual(parseCommonServeFlags([]), { yes: false });
});

test('extra handler claims command-specific flags', () => {
  let fore = false;
  const f = parseCommonServeFlags(['-f', 'model'], (a) => {
    if (a === '-f') {
      fore = true;
      return true;
    }
    return false;
  });
  assert.equal(fore, true);
  assert.equal(f.pattern, 'model');
});
