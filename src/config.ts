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
    defaultParallel: 1,
    defaultEmbedPort: 8090,
    noMmap: false,
    mtp: 'auto',
  };
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Read and normalise what's actually on disk — no defaults, no env overrides.
 * Kept separate from `loadConfig()` so `saveConfig()` can merge over the file
 * contents alone: merging over the *resolved* config would bake transient env
 * overrides (LOCCA_MODELS_DIR) into config.json permanently.
 */
function readConfigFile(): Partial<Config> {
  if (!existsSync(CONFIG_FILE)) return {};
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
    return coerced;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  let cfg: Config = { ...defaults(), ...readConfigFile() };
  // Env override for the models dir: a container has no config file to edit,
  // so this is how a Docker image points locca at a bind-mounted volume
  // without baking the path into config.json.
  if (process.env.LOCCA_MODELS_DIR) {
    cfg = { ...cfg, modelsDir: process.env.LOCCA_MODELS_DIR };
  }
  return cfg;
}

export function saveConfig(patch: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Merge over the file contents (plus defaults), never over loadConfig() —
  // see readConfigFile() for why.
  const merged = { ...defaults(), ...readConfigFile(), ...patch };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // Return the resolved view (env overrides applied) so callers see the same
  // shape loadConfig() would give them.
  return process.env.LOCCA_MODELS_DIR
    ? { ...merged, modelsDir: process.env.LOCCA_MODELS_DIR }
    : merged;
}
