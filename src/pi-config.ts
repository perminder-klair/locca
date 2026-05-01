import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Reserved provider key for entries locca manages. Anything else in the
 * user's models.json is left alone so they can keep their own custom
 * providers.
 */
export const PI_PROVIDER_KEY = 'locca';

interface PiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface PiProvider {
  name?: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models?: PiModel[];
}

interface PiModelsConfig {
  providers?: Record<string, PiProvider>;
  [key: string]: unknown;
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

export function piModelsJsonPath(): string {
  return join(piAgentDir(), 'models.json');
}

/**
 * Ensure `~/.pi/agent/models.json` has an entry for the model locca is
 * about to launch. Writes only the `locca` provider key — leaves any
 * other providers/models the user has registered untouched.
 *
 * Pi 0.70+ requires custom providers to be registered here; the older
 * `--provider llamacpp` flag was removed.
 */
export function ensurePiModelsJson(modelId: string, baseUrl: string, contextWindow: number): void {
  const path = piModelsJsonPath();

  let config: PiModelsConfig = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf8')) as PiModelsConfig;
    } catch {
      // corrupt file — start fresh; we'd lose other providers but parse
      // errors mean pi can't read it either.
      config = {};
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  if (!config.providers) config.providers = {};

  const existing = config.providers[PI_PROVIDER_KEY];
  const models: PiModel[] = Array.isArray(existing?.models) ? [...existing.models] : [];

  const modelEntry: PiModel = {
    id: modelId,
    name: modelId.replace(/\.gguf$/, ''),
    reasoning: false,
    input: ['text'],
    contextWindow,
    maxTokens: Math.min(8192, contextWindow),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const idx = models.findIndex((m) => m.id === modelId);
  if (idx >= 0) models[idx] = modelEntry;
  else models.push(modelEntry);

  config.providers[PI_PROVIDER_KEY] = {
    name: 'locca (local llama.cpp)',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'unused',
    models,
  };

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
