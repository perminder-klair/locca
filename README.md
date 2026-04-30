# locca

A TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp) for running,
managing, and benchmarking local GGUF models — and launching the
[`pi`](https://pi.dev) coding agent against your local server.

https://github.com/user-attachments/assets/8b451763-bc8a-4707-96f9-9bc78cf6de25

Works on **Linux + macOS**, against any GPU llama.cpp can target (Vulkan,
Metal, CUDA, ROCm) or CPU-only. Defaults are tuned for iGPU-class hardware
(q8_0 KV cache, single-slot serving, batch size 1024) so a 7B–9B model with
128k context fits comfortably on a 16 GB shared-VRAM iGPU.

## Quickstart

```bash
npm install -g @zeiq/locca
locca                  # first run launches the setup wizard
```

The setup wizard:

1. Asks for your **models directory** (default `~/.locca/models`, expands
   `~`, `mkdir -p` on confirm).
2. Lets you choose **Local** (locca spawns `llama-server` for you) or
   **External** (locca talks to a server you started yourself, on this
   machine or another). External URLs are probed before they're saved.
3. Sets **server defaults** (port / ctx / threads — confirm or customize).
4. Offers to install `pi`: tries `mise` → `npm` → manual hint.

It then writes `~/.locca/config.json` and drops you at the menu.

If `llama-server` isn't on `$PATH`, locca detects your distro and prints
the exact install command — apt for Debian/Ubuntu, dnf for Fedora,
pacman/AUR for Arch, zypper for openSUSE, apk for Alpine, brew for
macOS — including the non-obvious shader compiler packages (`glslc`,
`spirv-headers`) recent Vulkan builds need.

### Run from source (dev)

```bash
git clone https://github.com/perminder-klair/locca.git
cd locca
npm install
npm run build
npm link              # symlinks `locca` into your PATH
```

## Commands

```
locca                          # interactive menu (Pi is default)
locca pi [model-pattern]       # launch pi coding agent against a local server
locca serve                    # start llama-server with a picked model (detached)
locca switch [model-pattern]   # stop current server, start a new model with pi
locca bench                    # run llama-bench against a model
locca status                   # server / llama.cpp / models summary
locca api                      # print OpenAI-compatible connection info
locca logs                     # tail server log (pi-started servers only)
locca download [user/repo]     # pull a GGUF from HuggingFace
locca search   [query]         # search HuggingFace for GGUF models
locca delete                   # remove a model directory
locca stop                     # stop the running server
locca setup                    # re-run the setup wizard
locca help                     # full command listing
```

`locca pi qwen` will fuzzy-match the first `*qwen*.gguf` in your models dir.

## Connection info — `locca api`

When a server is running, `locca api` prints the OpenAI-compatible connection
block: base URL, the loaded model name, every endpoint (`/chat/completions`,
`/completions`, `/embeddings`, `/models`, plus native `/health`, `/props`,
`/slots`, `/metrics`), and a copy-pasteable `curl` quick-test.

If the server bound `0.0.0.0` (the default for `locca serve`), it also lists
every **LAN** and **Tailscale** URL the same server is reachable at — probed
live, so only working URLs show up. Useful for pointing a phone or another
machine at the same server.

The same output prints automatically after `locca serve` succeeds, so you
rarely need to call `api` directly.

## Defaults baked into the server

| Flag | Purpose |
|---|---|
| `--host 0.0.0.0` (`serve`) / `127.0.0.1` (`pi`) | bind for LAN access vs loopback only |
| `--n-gpu-layers 999` | All layers on GPU |
| `--flash-attn on` | Flash attention |
| `--cache-type-k q8_0 --cache-type-v q8_0` | Quantized KV cache (4× smaller than f16) |
| `--parallel 1` | Full context to a single slot (no 4-way division) |
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
| `*3B–9B*` dense | 131072 (128k) |
| Other / unrecognised | 32768 (32k) |

Edit `ctxForModel()` in `src/models.ts` to tune for your VRAM budget. Bigger
ctx = larger KV cache = more VRAM. q8_0 KV cache is what makes 128k feasible
on a shared-VRAM iGPU.

Sampling parameters (temperature, top_p, etc.) are read from the **GGUF
metadata** when `--jinja` is on — locca doesn't override. Verify what your
running server is using with `curl -s http://localhost:<port>/props | jq
'.default_generation_settings.params'`.

## Benchmarking — `locca bench`

Wraps `llama-bench -o json` and renders a friendlier summary than the raw
markdown table:

```
  Generation     18.3 tok/s   ≈   14 words/sec    drives perceived speed
  Prompt eval   231.4 tok/s   ≈  178 words/sec    parallel, batched

  Translates to:
    • 200-token reply         10.9 s
    • 2000-token reply        1m 49s
    • 1000-token prompt eval   4.3 s  (time-to-first-token)
```

Generation rate is what you "feel" when watching output stream; prompt-eval
rate determines time-to-first-token on long prompts.

## File layout

| Purpose | Path |
|---|---|
| Binary | wherever `npm` puts globals (`npm prefix -g`/bin) |
| Config | `~/.locca/config.json` |
| Server PID | `${XDG_RUNTIME_DIR:-/tmp}/locca-server.pid` |
| Server log | `${XDG_RUNTIME_DIR:-/tmp}/locca-server.log` |
| pi provider config | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` (written by locca) |
| Models dir (configurable) | `~/.locca/models` (default) |
| Downloaded GGUFs | `$modelsDir/<repo>/` |

On Linux, runtime files live in `/run/user/$UID/` and are wiped on reboot.
That's intentional.

## Server source taxonomy

`locca status` and `locca api` classify the running server into one of three
sources. The distinction drives what `serve` / `stop` / `logs` will let you do:

| Source | What it means | `serve`/`stop` allowed? |
|---|---|---|
| `pid` | locca spawned this server (PIDFILE in `XDG_RUNTIME_DIR`) | yes |
| `external` | `serverUrl` is configured in your config and reachable | no — manage where it was started |
| `attached` | no PIDFILE, but `/health` responds on `defaultPort` (a `llama-server` you started outside locca) | no — stop it via whatever started it |

This means locca composes cleanly with anything else that runs llama.cpp:
start a server by hand, with a supervisor, or via another tool, and locca
will detect it and use it via `locca pi` instead of fighting for VRAM with
a duplicate.

## Configuration

`locca setup` writes `~/.locca/config.json`. Edit by hand or re-run
the wizard:

```json
{
  "modelsDir": "/home/you/.locca/models",
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

`piSkillDir` is optional — when set to an existing directory it's passed to
`pi` as `--skill <dir>`.

`serverUrl` is optional — when set, locca uses an externally-managed
llama.cpp server (one you started yourself, or one running on another machine
on your LAN) instead of spawning its own. In that mode `serve`, `stop`, and
`logs` are disabled (they don't make sense — the server isn't ours to
manage). `pi`, `bench`, etc. still work.

Even without `serverUrl`, locca probes the configured `defaultPort` at
startup. If something already responds to `/health` (a llama-server you
started outside locca), locca marks it as **attached** (see the source
taxonomy above) and uses it instead of spawning a duplicate.

## Bundled skill (Claude Code / agent-aware editors)

The repo ships an [agent skill](.claude/skills/llama-cpp-manage/) at
`.claude/skills/llama-cpp-manage/` — a runbook for fresh sessions to lean on
when the user hits llama.cpp install pain, server startup failures, port
conflicts, or pi-coding-agent integration issues. Includes per-distro install
deps (apt/dnf/pacman/zypper/apk/brew), a build-error → apt-package map, the
`~/.pi/agent/models.json` registration pattern, and a read-only diagnostic
script:

```bash
bash .claude/skills/llama-cpp-manage/scripts/diagnose.sh
```

The script dumps a one-shot health snapshot — distro, llama.cpp binaries,
locca config, server `/health` + `/v1/models` + `/props`, PID file state,
models dir size, pi provider registration, and Vulkan device list.

If you don't use Claude Code or a similar agent harness, this directory is
harmless to ignore.

## Dependencies

**Required**

- `node` ≥ 20
- `llama.cpp` — install via your platform:
  - Arch: `sudo pacman -S llama.cpp` · `yay -S llama.cpp-vulkan-git` · `yay -S llama.cpp-hip-git`
  - macOS: `brew install llama.cpp`
  - Debian / Ubuntu / Fedora / openSUSE / Alpine: build from source —
    `locca setup` prints the exact `apt`/`dnf`/`zypper`/`apk` line you
    need; full deps reference at
    [`.claude/skills/llama-cpp-manage/references/install.md`](.claude/skills/llama-cpp-manage/references/install.md).

**Optional**

- `pi` ([pi.dev](https://pi.dev)) — required for the `locca pi` subcommand.
  The setup wizard offers to install it, or:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  # or
  mise use -g npm:@mariozechner/pi-coding-agent
  ```
- `vulkan-tools` — `vulkaninfo` for GPU diagnostics; locca's diagnose script
  uses it.
- `rocm-smi-lib` — VRAM monitoring on AMD discrete GPUs.
- `jq` — only used by `diagnose.sh` for prettier output; not required by locca itself.

## Updating

```bash
npm update -g @zeiq/locca
```

Or, if installed from source via `npm link`:

```bash
cd path/to/locca
git pull
npm install
npm run build
```

## Uninstall

```bash
npm uninstall -g @zeiq/locca
rm -rf "$HOME/.locca"                                   # remove config + models (optional)
rm -rf "$HOME/.pi/agent"                                # remove pi provider config (optional)
rm -f "${XDG_RUNTIME_DIR:-/tmp}/locca-server."{pid,log}
```

## License

MIT
