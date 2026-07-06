import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensurePiModelsJson, piModelsJsonPath } from '../../dist/pi-config.js';

function freshPiDir() {
  const dir = mkdtempSync(join(tmpdir(), 'locca-pi-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

test('ensurePiModelsJson creates models.json with the locca provider', () => {
  freshPiDir();
  ensurePiModelsJson('foo.gguf', 'http://127.0.0.1:8080/v1', 32768);
  const cfg = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
  const locca = cfg.providers.locca;
  assert.equal(locca.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(locca.models.length, 1);
  assert.equal(locca.models[0].id, 'foo.gguf');
  assert.equal(locca.models[0].contextWindow, 32768);
  assert.equal(locca.models[0].maxTokens, 8192);
});

test('ensurePiModelsJson leaves other providers untouched', () => {
  const dir = freshPiDir();
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        myown: { baseUrl: 'http://example.com', api: 'openai-completions', apiKey: 'k' },
      },
    }),
  );
  ensurePiModelsJson('foo.gguf', 'http://127.0.0.1:8080/v1', 32768);
  const cfg = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
  assert.equal(cfg.providers.myown.baseUrl, 'http://example.com');
  assert.ok(cfg.providers.locca);
});

test('ensurePiModelsJson updates an existing model entry in place', () => {
  freshPiDir();
  ensurePiModelsJson('foo.gguf', 'http://127.0.0.1:8080/v1', 32768);
  ensurePiModelsJson('foo.gguf', 'http://127.0.0.1:9090/v1', 65536);
  const cfg = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
  const locca = cfg.providers.locca;
  assert.equal(locca.models.length, 1);
  assert.equal(locca.baseUrl, 'http://127.0.0.1:9090/v1');
  assert.equal(locca.models[0].contextWindow, 65536);
});

test('small context windows cap maxTokens', () => {
  freshPiDir();
  ensurePiModelsJson('tiny.gguf', 'http://127.0.0.1:8080/v1', 4096);
  const cfg = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
  assert.equal(cfg.providers.locca.models[0].maxTokens, 4096);
});
