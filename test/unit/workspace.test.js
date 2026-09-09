import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listWorkspace, readWorkspace, workspacePath, writeWorkspace } from '../../dist/workspace.js';

test('workspace tools contain reads and writes, including symlink ancestors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'locca-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); await mkdir(root);
  await writeFile(join(dir, 'secret'), 'outside');
  await symlink(dir, join(root, 'escape'));
  await assert.rejects(workspacePath(root, '../secret'), /outside/);
  await assert.rejects(readWorkspace(root, 'escape/secret'), /outside/);
  await assert.rejects(writeWorkspace(root, 'escape/nested/new.txt', 'no'), /outside/);
  await writeWorkspace(root, 'nested/result.txt', 'hello');
  assert.equal(await readWorkspace(root, 'nested/result.txt'), 'hello');
  await writeWorkspace(root, 'nested/result.txt', 'updated');
  assert.equal(await readFile(join(root, 'nested/result.txt'), 'utf8'), 'updated');
  assert.deepEqual((await listWorkspace(root)).map((f) => f.name), ['nested']);
});
