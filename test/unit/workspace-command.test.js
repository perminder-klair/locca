import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWorkspaceCommand } from '../../dist/workspace-command.js';

test('host commands report failures and exclude agent credentials', async () => {
  process.env.LOCCA_RUNTIME_TOKEN = 'must-not-reach-command';
  try {
    const result = await runWorkspaceCommand(tmpdir(), 'printf "%s" "${LOCCA_RUNTIME_TOKEN:-absent}"; exit 7', 5);
    assert.equal(result.stdout, 'absent'); assert.equal(result.exitCode, 7);
  } finally { delete process.env.LOCCA_RUNTIME_TOKEN; }
});

test('cancellation kills the shell process group promptly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'locca-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const task = runWorkspaceCommand(dir, 'sleep 30 & wait', 30, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const result = await task;
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /cancelled/);
});
