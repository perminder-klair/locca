# pi-llm

A `gum`-powered TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp)
for running, managing, and benchmarking local GGUF models — and launching the
[`pi`](https://pi.dev) coding agent against your local server.

Tuned for AMD Strix Halo / Radeon 890M (Vulkan, q8_0 KV cache, single-slot
serving), but works on any system where `llama-server` and `llama-cli` are on
`$PATH`.

## Quickstart

```bash
git clone https://github.com/perminder-klair/pi-llm.git
cd pi-llm
./install.sh
```

The installer:

1. Bootstraps `gum` (via pacman if missing).
2. Checks core deps (`bash curl jq python`) and offers `pacman -S` for any missing.
3. Verifies `llama-server` / `llama-cli` are on `$PATH` (suggests official, AUR, or source builds).
4. Reports optional tools (`rocm-smi`, `vulkaninfo`).
5. Asks for the models directory (default `~/.lmstudio/models`, expands `~`, `mkdir -p` on confirm).
6. Sets server defaults (port / ctx / threads — confirm or customize).
7. Offers to install `pi` (default **yes**): tries `mise` → `npm` → `pacman -S nodejs-lts npm` → manual hint.
8. Writes config to `~/.config/pi-llm/config`.
9. Installs the binary: Arch package (`makepkg -si`) **or** symlink to `~/.local/bin/pi-llm`.

After install, run `pi-llm` for the interactive menu.

## Commands

```
pi-llm                          # interactive menu (Pi is default)
pi-llm pi [model-pattern]       # launch pi coding agent against a local server
pi-llm serve                    # start llama-server with a picked model
pi-llm chat                     # interactive terminal chat (llama-cli)
pi-llm switch [model-pattern]   # stop current server, start a new model with pi
pi-llm bench                    # run llama-bench against a model
pi-llm status                   # list models + server status
pi-llm info                     # GGUF metadata for a picked model
pi-llm logs                     # tail server log (pi-started servers only)
pi-llm download [user/repo]     # pull a GGUF from HuggingFace
pi-llm search   [query]         # search HuggingFace for GGUF models
pi-llm delete                   # remove a model directory
pi-llm stop                     # stop the running server
pi-llm help                     # full command listing
```

`pi-llm pi qwen` will fuzzy-match the first `*qwen*.gguf` in your models dir.

## Defaults baked into the server

| Flag | Purpose |
|---|---|
| `--n-gpu-layers 999` | All layers on GPU (Vulkan) |
| `--flash-attn on` | Flash attention |
| `--cache-type-k q8_0 --cache-type-v q8_0` | Quantized KV cache (4× smaller than f16) |
| `--parallel 1` | Full context goes to a single slot (no 4-way division) |
| `--cache-reuse 256` | KV reuse across multi-turn requests |
| `--jinja` | Proper chat template handling |
| `--image-min-tokens 1024` | Auto-added when an `mmproj*.gguf` sibling is detected |

Per-model context auto-tuning (`ctx_for_model()`):

| Model class | Auto context |
|---|---|
| MoE / `*A3B*` | 131072 (128k) |
| `*30B–35B*` dense | 65536 (64k) |
| `*22B–27B*` dense | 32768 (32k) |
| `*12B–14B*` dense | 65536 (64k) |
| `*3B–8B*` | 131072 (128k) |
| Other | 32768 (32k) |

Edit `ctx_for_model()` in the script to tune for your VRAM budget.

## File layout

| Purpose | Path |
|---|---|
| Binary (pacman install) | `/usr/bin/pi-llm` |
| Binary (symlink install) | `~/.local/bin/pi-llm` |
| Config | `${XDG_CONFIG_HOME:-~/.config}/pi-llm/config` |
| Server PID | `${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.pid` |
| Server log | `${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.log` |
| Models dir (configurable) | `~/.lmstudio/models` (default) |
| Downloaded GGUFs | `$MODELS_DIR/extra-models/<repo>/` |

Runtime files live in `/run/user/$UID/` on Linux — wiped on reboot. That's intentional.

## Configuration

`install.sh` writes `~/.config/pi-llm/config`. The script sources it at startup.
Any value can be overridden:

```bash
MODELS_DIR="$HOME/.lmstudio/models"
DEFAULT_PORT=8080
DEFAULT_CTX=32768
DEFAULT_THREADS=10
LLAMA_SERVER="llama-server"
LLAMA_CLI="llama-cli"
```

Source builds: if `llama-server` isn't on `$PATH`, point `LLAMA_SERVER` at the
absolute path:

```bash
LLAMA_SERVER="$HOME/llama.cpp/build/bin/llama-server"
LLAMA_CLI="$HOME/llama.cpp/build/bin/llama-cli"
```

Re-run `./install.sh` any time — it pre-fills your existing values.

## Dependencies

**Required**

- `bash`, `gum`, `curl`, `jq`, `python`
- `llama.cpp` — official Arch package, AUR variant, or source build:
  - `sudo pacman -S llama.cpp`
  - `yay -S llama.cpp-vulkan-git` (Vulkan / AMD)
  - `yay -S llama.cpp-hip-git` (ROCm)
  - source: <https://github.com/ggml-org/llama.cpp>

**Optional**

- `pi` ([pi.dev](https://pi.dev)) — required for the `pi-llm pi` subcommand. Install:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  # or
  mise use -g npm:@mariozechner/pi-coding-agent
  ```
- `rocm-smi-lib` — VRAM monitoring on AMD GPUs.
- `vulkan-tools` — Vulkan device introspection.

## Updating

If you installed via `makepkg -si` (binary at `/usr/bin/pi-llm`):

```bash
cd ~/Projects/pi-llm
git pull
makepkg -si --force      # or bump pkgrel in PKGBUILD
```

If you installed via symlink (binary at `~/.local/bin/pi-llm`):

```bash
cd ~/Projects/pi-llm
git pull                 # changes are live immediately
```

Check which one you have:

```bash
ls -la "$(command -v pi-llm)"   # arrow → symlink, regular file → pacman
```

## Uninstall

```bash
sudo pacman -R pi-llm                                   # if installed via package
rm -f "$HOME/.local/bin/pi-llm"                         # if installed via symlink
rm -rf "$HOME/.config/pi-llm"                           # remove config (optional)
rm -f /run/user/$UID/pi-llm-server.{pid,log}            # cleanup runtime cruft
```

## License

MIT
