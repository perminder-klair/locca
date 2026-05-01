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
    piSkills: 'lazy',
    piExtensions: true,
  };
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  const base = defaults();
  if (!existsSync(CONFIG_FILE)) return base;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config> & {
      piSkills?: Config['piSkills'] | boolean;
    };
    // Migrate legacy boolean piSkills → tri-state. true was the old "skills on"
    // and false was the old "--no-skills" — neither matches the new default of
    // 'lazy', so we preserve the user's prior intent rather than forcing it.
    const { piSkills, ...rest } = raw;
    const coerced: Partial<Config> = { ...rest };
    if (typeof piSkills === 'boolean') coerced.piSkills = piSkills ? 'on' : 'off';
    else if (piSkills !== undefined) coerced.piSkills = piSkills;
    return { ...base, ...coerced };
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
