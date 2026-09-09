import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('durable model IDs resolve locally and unknown IDs cannot fall back to the cloud', () => {
  const script = `
    import assert from 'node:assert/strict';
    assert.equal(globalThis.AI_SDK_DEFAULT_PROVIDER.languageModel('locca/test.gguf').modelId, 'test.gguf');
    assert.throws(() => globalThis.AI_SDK_DEFAULT_PROVIDER.languageModel('openai/anything'));
    console.log('local-only');
  `;
  const output = execFileSync(process.execPath, ['--import', resolve('dist/local-provider.js'), '--input-type=module', '-e', script], {
    env: { ...process.env, LOCCA_INFERENCE_URL: 'http://127.0.0.1:1/v1', LOCCA_MODEL_ID: 'test.gguf' }, encoding: 'utf8',
  });
  assert.equal(output.trim(), 'local-only');
});
