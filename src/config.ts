import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.js';
import { autoThreads } from './util.js';

const CONFIG_DIR = join(homedir(), '.locca');

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function defaults(): Config {
  return {
    modelsDir: join(homedir(), '.locca', 'models'),
    defaultPort: 8080,
    defaultCtx: 32768,
    defaultThreads: autoThreads(),
    llamaServer: 'llama-server',
    llamaCli: 'llama-cli',
    llamaBench: 'llama-bench',
  };
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  const base = defaults();
  if (!existsSync(CONFIG_FILE)) return base;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

export function saveConfig(patch: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const merged = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
