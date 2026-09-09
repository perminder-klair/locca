import pc from 'picocolors';
import { renderLlamaInstallHint } from './distro.js';
import type { Config } from './types.js';
import { have } from './util.js';

export function requireLlama(cfg: Config): void {
  if (have(cfg.llamaServer)) return;
  console.error(`${pc.red(pc.bold('locca:'))} ${pc.bold(`'${cfg.llamaServer}' not found in PATH.`)}

${renderLlamaInstallHint()}

${pc.dim('If you built llama.cpp elsewhere, set llamaServer / llamaCli in ~/.locca/config.json to absolute paths.')}`);
  process.exit(1);
}
