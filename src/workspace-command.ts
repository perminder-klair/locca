import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Approved host commands get a process group so cancellation also reaches descendants. */
export async function runWorkspaceCommand(
  cwd: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw new Error('Command cancelled.');
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      stopped = false;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      stderr += `\n${reason}`;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const abort = () => stop('Command cancelled.');
    const timer = setTimeout(() => stop('Command timed out.'), timeoutSeconds * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        stop('Command output exceeded 1 MB.');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => capture(chunk, 'stderr'));
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode: stopped ? 1 : (code ?? 1), stdout, stderr });
    });
  });
}
