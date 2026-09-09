import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { agentDataDir } from './agent-store.js';

export interface AgentRuntime {
  pid: number;
  port: number;
  token: string;
  modelId: string;
  baseUrl: string;
  contextWindow: number;
  workspace: string;
}

export function runningAgent(): AgentRuntime | null {
  const file = join(agentDataDir(), 'service.json');
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as AgentRuntime;
    if (!Number.isSafeInteger(state.pid) || state.pid <= 1) return null;
    process.kill(state.pid, 0);
    // A stale PID file must never make us signal an unrelated reused PID.
    if (process.platform === 'linux') {
      const command = readFileSync(`/proc/${state.pid}/cmdline`, 'utf8');
      if (!command.split('\0').some((arg) => arg.endsWith('/agent-service.js'))) return null;
    }
    return state;
  } catch {
    return null;
  }
}

export function assertAgentStopped(): void {
  if (runningAgent())
    throw new Error(
      'Stop the agent service with `locca agent stop` before changing its inference server. Saved sessions are retained.',
    );
}

/** An exclusive owner prevents two Eve processes from writing one workflow store. */
export function claimAgentOwnership(dir: string): () => void {
  const path = join(dir, 'owner.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
      let alive = false;
      try {
        if (Number.isSafeInteger(owner.pid) && owner.pid > 1) {
          process.kill(owner.pid, 0);
          alive = true;
        }
      } catch {}
      if (alive) throw new Error('Another Locca agent service already owns this data directory.');
      unlinkSync(path);
    }
  }
  throw new Error('Could not acquire the agent data directory.');
}
