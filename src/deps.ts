import type { Config } from './types.js';
import { have } from './util.js';

export function requirePi(): void {
  if (have('pi')) return;
  console.error(`pi-llm: 'pi' (coding agent) not found in PATH.

The 'pi' subcommand requires the pi CLI. Install it with:
  npm install -g @mariozechner/pi-coding-agent
or via mise:
  mise use -g npm:@mariozechner/pi-coding-agent

Docs: https://pi.dev  |  Source: https://github.com/badlogic/pi-mono

If you only want serve/chat/bench, use those subcommands — they don't
need pi.`);
  process.exit(1);
}

export function requireLlama(cfg: Config): void {
  if (have(cfg.llamaServer)) return;
  console.error(`pi-llm: '${cfg.llamaServer}' not found in PATH.

Install llama.cpp:
  Arch:    sudo pacman -S llama.cpp
           yay -S llama.cpp-vulkan-git           # AUR (Vulkan / Radeon)
           yay -S llama.cpp-hip-git              # AUR (ROCm / HIP)
  macOS:   brew install llama.cpp
  Other:   build from source — https://github.com/ggml-org/llama.cpp

  Quick Vulkan build:
    git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
    cmake -B ~/llama.cpp/build -S ~/llama.cpp -DGGML_VULKAN=ON
    cmake --build ~/llama.cpp/build -j
    export PATH="$HOME/llama.cpp/build/bin:$PATH"

If you built from source, ensure llama-server/llama-cli are on $PATH or
set llamaServer / llamaCli in ~/.config/pi-llm/config.json to absolute paths.`);
  process.exit(1);
}
