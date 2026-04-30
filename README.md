# pi-llm

A TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp) for running,
managing, and benchmarking local GGUF models — and launching the
[`pi`](https://pi.dev) coding agent against your local server.

Tuned for AMD Strix Halo / Radeon 890M (Vulkan, q8_0 KV cache, single-slot
serving), but works on any system where `llama-server` and `llama-cli` are on
`$PATH`. Linux + macOS.

## Quickstart

```bash
npm install -g pi-llm
pi-llm                # first run launches the setup wizard
```

The wizard asks for:

1. Models directory (default `~/.lmstudio/models`, expands `~`, `mkdir -p` on confirm).
2. Server defaults (port / ctx / threads — confirm or customize).
3. Whether to install `pi` (default **yes**): tries `mise` → `npm` → manual hint.

It then writes `~/.config/pi-llm/config.json` and drops you at the menu.

If `llama-server` isn't on `$PATH`, the wizard reports it with install hints
(`pacman` / `brew` / source build) and you can fix that before running any of
the inference commands.

### Run from source (dev)

```bash
git clone https://github.com/perminder-klair/pi-llm.git
cd pi-llm
npm install
npm run build
npm link              # symlinks `pi-llm` into your PATH
```

## Commands

```
pi-llm                          # interactive menu (Pi is default)
pi-llm pi [model-pattern]       # launch pi coding agent against a local server
pi-llm serve                    # start llama-server with a picked model (detached)
pi-llm switch [model-pattern]   # stop current server, start a new model with pi
pi-llm bench                    # run llama-bench against a model
pi-llm status                   # server / llama.cpp / models summary
pi-llm api                      # print OpenAI-compatible connection info
pi-llm logs                     # tail server log (pi-started servers only)
pi-llm download [user/repo]     # pull a GGUF from HuggingFace
pi-llm search   [query]         # search HuggingFace for GGUF models
pi-llm delete                   # remove a model directory
pi-llm stop                     # stop the running server
pi-llm setup                    # re-run the setup wizard
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
| `--batch-size 1024` | Larger prompt-processing batches (faster on iGPUs) |
| `--jinja` | Proper chat template handling |
| `--mmproj <file>` | Auto-added when an `mmproj*.gguf` sibling is detected |

Per-model context auto-tuning (`ctxForModel()` in `src/models.ts`):

| Model class | Auto context |
|---|---|
| MoE / `*A3B*` | 131072 (128k) |
| `*30B–35B*` dense | 65536 (64k) |
| `*22B–27B*` dense | 32768 (32k) |
| `*12B–14B*` dense | 65536 (64k) |
| `*3B–8B*` | 131072 (128k) |
| Other | 32768 (32k) |

Edit `ctxForModel()` in `src/models.ts` to tune for your VRAM budget.

## File layout

| Purpose | Path |
|---|---|
| Binary | wherever `npm` puts globals (`npm prefix -g`/bin) |
| Config | `${XDG_CONFIG_HOME:-~/.config}/pi-llm/config.json` |
| Server PID | `${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.pid` |
| Server log | `${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.log` |
| Models dir (configurable) | `~/.lmstudio/models` (default) |
| Downloaded GGUFs | `$modelsDir/<repo>/` |

On Linux, runtime files live in `/run/user/$UID/` and are wiped on reboot.
That's intentional.

## Configuration

`pi-llm setup` writes `~/.config/pi-llm/config.json`. Edit by hand or re-run
the wizard:

```json
{
  "modelsDir": "/home/you/.lmstudio/models",
  "defaultPort": 8080,
  "defaultCtx": 32768,
  "defaultThreads": 10,
  "llamaServer": "llama-server",
  "llamaCli": "llama-cli",
  "llamaBench": "llama-bench",
  "piSkillDir": "/home/you/.claude/skills/agent-browser",
  "serverUrl": "http://localhost:8081"
}
```

Source builds: if the binaries aren't on `$PATH`, point them at absolute paths:

```json
{
  "llamaServer": "/home/you/llama.cpp/build/bin/llama-server",
  "llamaCli":    "/home/you/llama.cpp/build/bin/llama-cli",
  "llamaBench":  "/home/you/llama.cpp/build/bin/llama-bench"
}
```

`piSkillDir` is optional — when set to an existing directory it's passed to `pi`
as `--skill <dir>`.

`serverUrl` is optional — when set, pi-llm uses an externally-managed
llama.cpp server (e.g. one you started yourself, or one running on another
machine on your LAN) instead of spawning its own. In that mode `serve`,
`stop`, and `logs` are disabled (they don't make sense — the server isn't
ours to manage). `pi`, `bench`, etc. still work.

Even without `serverUrl`, pi-llm probes the configured `defaultPort` at
startup. If something already responds to `/health` (a llama-server you
started outside pi-llm, etc.), pi-llm marks it as **attached** and uses
it instead of spawning a duplicate that would fight for VRAM.

| Source | What it means | `serve`/`stop` allowed? |
|---|---|---|
| `pid` | pi-llm spawned this server | yes |
| `external` | `serverUrl` is configured and reachable | no — manage where it was started |
| `attached` | something else is on the local port | no — stop it via its launcher |

## Dependencies

**Required**

- `node` ≥ 20
- `llama.cpp` — install via your platform:
  - Arch: `sudo pacman -S llama.cpp` · `yay -S llama.cpp-vulkan-git` · `yay -S llama.cpp-hip-git`
  - macOS: `brew install llama.cpp`
  - Anywhere else: build from source — <https://github.com/ggml-org/llama.cpp>

**Optional**

- `pi` ([pi.dev](https://pi.dev)) — required for the `pi-llm pi` subcommand.
  The setup wizard offers to install it for you, or:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  # or
  mise use -g npm:@mariozechner/pi-coding-agent
  ```
- `rocm-smi-lib` — VRAM monitoring on AMD GPUs.
- `vulkan-tools` — Vulkan device introspection.

## Updating

```bash
npm update -g pi-llm
```

Or, if installed from source via `npm link`:

```bash
cd path/to/pi-llm
git pull
npm install
npm run build
```

## Uninstall

```bash
npm uninstall -g pi-llm
rm -rf "$HOME/.config/pi-llm"                           # remove config (optional)
rm -f "${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server."{pid,log}
```

## License

MIT
