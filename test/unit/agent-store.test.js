import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAgentStore } from '../../dist/agent-store.js';
import { parseAgentArgs } from '../../dist/commands/agent.js';
import { claimAgentOwnership } from '../../dist/agent-runtime.js';

test('sessions and recurring jobs survive reopening their store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'locca-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = openAgentStore(dir);
  store.addSession({ id: 'one', title: 'Example', workspace: '/tmp', createdAt: 1 });
  store.addJob({ id: 'job', title: 'Review', prompt: 'Review files', workspace: '/tmp', intervalMinutes: 60, nextRun: 1, enabled: 1, lastSession: null, error: null });
  store.close(); store = openAgentStore(dir);
  assert.equal(store.session('one').title, 'Example');
  store.finishJob('job', 20, 'one', null);
  assert.equal(store.jobs()[0].lastSession, 'one');
  store.deleteJob('job'); assert.equal(store.jobs().length, 0); store.close();
});

test('agent CLI validates flags instead of forwarding them to another program', () => {
  assert.equal(parseAgentArgs(['qwen', '--port', '3212', '--no-open']).port, 3212);
  assert.throws(() => parseAgentArgs(['--port', '0']), /port/);
  assert.throws(() => parseAgentArgs(['--workspace']), /Missing/);
  assert.throws(() => parseAgentArgs(['--provider', 'cloud']), /Unexpected/);
});

test('only one service can own a workflow data directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'locca-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = claimAgentOwnership(dir);
  assert.throws(() => claimAgentOwnership(dir), /already owns/);
  release(); const next = claimAgentOwnership(dir); next();
});
