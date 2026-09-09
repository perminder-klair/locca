import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export async function workspaceRoot(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
  return root;
}

export async function workspacePath(root: string, path: string, create = false): Promise<string> {
  if (isAbsolute(path)) throw new Error('Use a workspace-relative path.');
  const base = await workspaceRoot(root);
  const target = resolve(base, path);
  const inside = (value: string) => {
    const rel = relative(base, value);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(target)) throw new Error('Path is outside the workspace.');
  let current = target;
  while (true) {
    try {
      if (!inside(await realpath(current)))
        throw new Error('Symlink points outside the workspace.');
      break;
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = dirname(current);
    }
  }
  return target;
}

export async function listWorkspace(root: string, path = '.') {
  const target = await workspacePath(root, path);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
      path: relative(root, resolve(target, entry.name)),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .slice(0, 500);
}

export async function readWorkspace(root: string, path: string) {
  const target = await workspacePath(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > 1_000_000)
    throw new Error('Choose a text file smaller than 1 MB.');
  return readFile(target, 'utf8');
}

export async function writeWorkspace(root: string, path: string, content: string) {
  const target = await workspacePath(root, path, true);
  if (Buffer.byteLength(content) > 1_000_000) throw new Error('File exceeds 1 MB.');
  await mkdir(dirname(target), { recursive: true });
  await workspacePath(root, path, true);
  const temp = `${target}.locca-${randomUUID()}`;
  await writeFile(temp, content, { flag: 'wx' });
  await rename(temp, target);
  return { path, bytes: Buffer.byteLength(content) };
}
