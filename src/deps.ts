import pc from 'picocolors';
import { renderLlamaInstallHint } from './distro.js';
import type { Config } from './types.js';
import { have } from './util.js';

export function requirePi(): void {
  if (have('pi')) return;
  console.error(`${pc.red(pc.bold('locca:'))} ${pc.bold(`'pi' (coding agent) not found in PATH.`)}

The ${pc.cyan('pi')} subcommand requires the pi CLI. Install it with:
  ${pc.cyan('npm install -g @mariozechner/pi-coding-agent')}
or via ${pc.bold('mise')}:
  ${pc.cyan('mise use -g npm:@mariozechner/pi-coding-agent')}

${pc.dim('Docs:')} ${pc.underline('https://pi.dev')}  ${pc.dim('|')}  ${pc.dim('Source:')} ${pc.underline('https://github.com/badlogic/pi-mono')}

${pc.dim(`If you only want serve/chat/bench, use those subcommands — they don't need pi.`)}`);
  process.exit(1);
}

export function requireLlama(cfg: Config): void {
  if (have(cfg.llamaServer)) return;
  console.error(`${pc.red(pc.bold('locca:'))} ${pc.bold(`'${cfg.llamaServer}' not found in PATH.`)}

${renderLlamaInstallHint()}

${pc.dim('If you built llama.cpp elsewhere, set llamaServer / llamaCli in ~/.locca/config.json to absolute paths.')}`);
  process.exit(1);
}
