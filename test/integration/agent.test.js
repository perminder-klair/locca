import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { startInferenceFixture } from '../fixtures/inference.js';
import { openAgentStore } from '../../dist/agent-store.js';

test('Eve local flow: tools, approvals, replay, restart, cancellation, and protected routes', { timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'locca-eve-test-'));
  const workspace = join(dir, 'workspace'); await mkdir(workspace);
  const fixture = await startInferenceFixture();
  const reserve = createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const token = 'test-token';
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(join(dir, 'launch.json'), JSON.stringify({ port, token, workspace, modelId: 'locca-test.gguf', baseUrl: `http://127.0.0.1:${fixture.port}/v1`, contextWindow: 8192 }));
  let service, logs = '';
  async function start() {
    service = spawn(process.execPath, [resolve(process.env.LOCCA_TEST_PACKAGE_ROOT || '.', 'dist/agent-service.js'), join(dir, 'launch.json')], { env: { ...process.env, LOCCA_AGENT_DATA_DIR: dir } });
    service.stdout.on('data', (chunk) => { logs += chunk; }); service.stderr.on('data', (chunk) => { logs += chunk; });
    for (let i = 0; i < 100; i++) {
      try { const res = await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } }); if (res.ok) return; } catch {}
      if (service.exitCode !== null) throw new Error(logs);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Startup timeout: ${logs}`);
  }
  async function stop() {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    const exited = new Promise((r) => service.once('exit', r)); service.kill('SIGTERM'); await exited;
  }
  t.after(async () => { await stop(); fixture.server.closeAllConnections(); await new Promise((r) => fixture.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  async function api(path, method = 'GET', input) {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
    const data = await res.json(); assert.ok(res.ok, `${res.status}: ${JSON.stringify(data)}\n${logs}`); return data;
  }
  async function until(id, predicate) {
    let events = [];
    for (let i = 0; i < 120; i++) {
      events = (await api(`/sessions/${id}/events`)).events;
      if (predicate(events)) return events;
      if (events.some((e) => e.type === 'session.failed')) throw new Error(`Session failed: ${JSON.stringify(events)}\n${logs}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Event timeout: ${JSON.stringify(events)}\n${logs}`);
  }
  await start();
  assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  const session = await api('/sessions', 'POST', { workspace, message: 'WRITE_FIXTURE' });
  const completed = await until(session.id, (events) => events.some((e) => e.type === 'session.waiting'));
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'Created by Eve through local inference.\n');
  assert.ok(completed.some((e) => e.type === 'action.result'));
  assert.ok(fixture.requests.every((r) => r.model === 'locca-test.gguf'));
  await stop(); await start();
  assert.equal((await api('/sessions'))[0].id, session.id);
  assert.equal((await api(`/sessions/${session.id}/events`)).events.length, completed.length);
  await api(`/sessions/${session.id}/message`, 'POST', { message: 'BASH_FIXTURE' });
  const pending = await until(session.id, (events) => events.some((e) => e.type === 'input.requested'));
  const request = pending.findLast((e) => e.type === 'input.requested').data.requests[0];
  await assert.rejects(readFile(join(workspace, 'approved.txt')));
  await stop(); await start();
  assert.ok((await api(`/sessions/${session.id}/events`)).events.some((e) => e.type === 'input.requested'));
  await api(`/sessions/${session.id}/respond`, 'POST', { responses: [{ requestId: request.requestId, optionId: 'approve' }] });
  await until(session.id, (events) => events.some((e) => e.type === 'input.resolved') && events.at(-1)?.type === 'session.waiting');
  assert.equal(await readFile(join(workspace, 'approved.txt'), 'utf8'), 'approved');
  await api(`/sessions/${session.id}/compact`, 'POST', {});
  await until(session.id, (events) => events.some((e) => e.type === 'compaction.completed') && events.at(-1)?.type === 'session.waiting');
  const slow = await api('/sessions', 'POST', { workspace, message: 'SLOW_FIXTURE' });
  await until(slow.id, (events) => events.some((e) => e.type === 'message.appended'));
  await api(`/sessions/${slow.id}/cancel`, 'POST', {});
  await until(slow.id, (events) => events.some((e) => e.type === 'turn.cancelled'));
  const job = await api('/jobs', 'POST', { title: 'Review', prompt: 'Hello', workspace, intervalMinutes: 60 });
  assert.equal((await api('/jobs'))[0].id, job.id);
  const store = openAgentStore(dir); store.finishJob(job.id, 0, null, null); store.close();
  let run;
  for (let i = 0; i < 60; i++) {
    run = (await api('/jobs'))[0]; if (run.lastSession) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(run.lastSession, 'Overdue scheduled job was dispatched');
  await until(run.lastSession, (events) => events.at(-1)?.type === 'session.waiting');
  await api(`/jobs/${job.id}`, 'DELETE'); assert.equal((await api('/jobs')).length, 0);
  t.diagnostic('Real Eve runtime used a local OpenAI-compatible fixture; no cloud model was called.');
});
