# locca

A TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp) for running,
managing, and benchmarking local GGUF models, and for launching the
[`pi`](https://pi.dev) coding agent against your local server.

https://github.com/user-attachments/assets/3a767b12-69ad-406c-a2af-c071132ac28c

Works on Linux and macOS, against any GPU llama.cpp can target (Vulkan,
Metal, CUDA, ROCm) or CPU-only. Defaults are tuned for iGPU-class hardware
(q8_0 KV cache, single slot, batch size 1024) so a 7B–9B model with 128k
context fits on a 16 GB shared-VRAM iGPU.

## Quickstart

```bash
npm install -g @zeiq/locca
locca                  # first run launches the setup wizard
```

The setup wizard:

1. Asks for your **models directory** (default `~/.locca/models`).
2. Confirms `llama-server` is on `$PATH`. If not, prints the exact install
   line for your distro (apt, dnf, pacman/AUR, zypper, apk, brew),
   including the shader compiler packages (`glslc`, `spirv-headers`)
   recent Vulkan builds need.
3. Sets server defaults (port, ctx, threads, VRAM budget tier).
4. If the models dir is empty, offers a catalog-aware first model picker.
   Each curated size shows a `fits — 5.6 GB dl, 14.3 GB RAM, 256k ctx`
   (or `needs 32 GB+ RAM`) hint based on detected hardware, so you can't
   accidentally pick a 30 GB download that won't run.
5. Offers to install `pi`: tries `mise` → `npm` → manual hint.

Then it writes `~/.locca/config.json` and drops you at the menu.

### Run from source

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
locca pi [model-pattern]       # launch pi against a local server
locca serve [model] [opts]     # start llama-server (interactive pick, or head-less: `locca serve qwen3.5-9b`)
locca switch                   # picker: installed models + curated catalog
locca bench                    # run llama-bench against a model
locca doctor                   # health check: hardware, llama.cpp, server, log, config
locca optimise                 # ask pi to review the deployment and suggest tweaks
locca api                      # print OpenAI-compatible connection info
locca logs                     # tail server log (locca-started servers only)
locca download [user/repo]     # pull a GGUF from HuggingFace
locca search   [query]         # search HuggingFace for GGUF models
locca delete                   # remove a model directory
locca stop                     # stop the running server
locca config                   # view / edit ~/.locca/config.json
locca setup                    # re-run the setup wizard
locca install-llama            # download a prebuilt llama.cpp binary into ~/.locca/bin
locca help                     # full command listing
```

`locca pi qwen` fuzzy-matches the first `*qwen*.gguf` in your models dir.

## `locca api`

When a server is running, `locca api` prints the OpenAI-compatible
connection block: base URL, loaded model name, every endpoint
(`/chat/completions`, `/completions`, `/embeddings`, `/models`, plus
native `/health`, `/props`, `/slots`, `/metrics`), and a copy-pasteable
`curl` quick-test.

If the server bound `0.0.0.0` (the default for `locca serve`), it also
lists every reachable LAN and Tailscale URL, probed live so only
working ones show up. Handy for pointing a phone or another machine at
the same server.

The same output prints automatically after `locca serve` succeeds.

## Head-less `serve`

`locca serve` is interactive by default — it prompts for the model and
settings. Pass a model name (or set `LOCCA_MODEL`) and it runs with no
prompts, which is what you need in Docker, systemd, or CI where there's no
terminal:

```
locca serve qwen3.5-9b                     # config defaults, detached
locca serve qwen3.5-9b -p 8080 -c 16384    # explicit port + context
locca serve qwen3.5-9b -f                  # foreground: streams logs, stays up until killed
```

The model argument is a substring match against your models dir (same as
`locca pi qwen`). With no TTY and no model named, `serve` prints a clear
error and lists the available models instead of hanging on the picker.

| Flag | Env | Default |
|---|---|---|
| `-p, --port` | `LOCCA_PORT` | config `defaultPort` |
| `-c, --ctx` | `LOCCA_CTX` | config `defaultCtx` |
| `-t, --threads` | `LOCCA_THREADS` | config `defaultThreads` |
| `-H, --host` | `LOCCA_HOST` | `0.0.0.0` |
| `-f, --foreground` | `LOCCA_FOREGROUND=1` | off (detached) |
| `-y, --yes` | — | accept defaults, no prompts |

`-f` (foreground) makes locca the supervisor of `llama-server`: logs go to
stdout, SIGTERM/Ctrl-C stops it cleanly, and locca exits only when the
server does. That's the right shape for a container's main process.

## Running in Docker

The repo ships a `Dockerfile` and `docker-compose.yml` that run llama.cpp's
OpenAI-compatible server head-less — handy if you're pointing a tool like
[SUB/WAVE](https://github.com/perminder-klair/subwave) at a local model and
want to control the llama.cpp version and flags yourself (instead of
whatever Ollama bundles).

```bash
# Build (CPU — runs anywhere)
docker build -t locca .

# Run: mount your GGUF models, name the model to serve
docker run --rm -p 8080:8080 \
    -v /path/to/models:/models:ro \
    locca qwen3.5-9b
```

Or with compose — drop GGUFs in `./models`, set the model in
`docker-compose.yml`, then `docker compose up -d`.

Point any OpenAI-compatible client at `http://<host>:8080/v1`. In SUB/WAVE:
**admin → Settings → LLM provider = `openai-compatible`**, base URL
`http://locca:8080/v1` (same compose network) or `http://<host-ip>:8080/v1`
from elsewhere. No API key is required.

**Models** mount at `/models` (overridable with `LOCCA_MODELS_DIR`).
**GPU:** build with `--build-arg LLAMA_BACKEND=vulkan` and pass
`--device /dev/dri` (AMD/Intel) — see the commented block in
`docker-compose.yml`. The default CPU build needs no GPU and runs anywhere.

> If you hit the `GGML_ASSERT(n_inputs < GGML_SCHED_MAX_SPLIT_INPUTS)` crash
> (a known llama.cpp assert that kills the server mid-request), it's usually
> parallel slots combined with a large context. locca defaults to
> `--parallel 1`; lowering `LOCCA_CTX` is the other lever.

## Server defaults

| Flag | Purpose |
|---|---|
| `--host 0.0.0.0` (`serve`) / `127.0.0.1` (`pi`) | LAN access vs loopback only |
| `--n-gpu-layers 999` | All layers on GPU |
| `--flash-attn on` | Flash attention |
| `--cache-type-k q8_0 --cache-type-v q8_0` | Quantized KV cache (4× smaller than f16) |
| `--parallel 1` | Full context to a single slot — raise `defaultParallel` in config for N concurrent slots (splits ctx evenly) |
| `--cache-reuse 256` | KV reuse across multi-turn requests |
| `--batch-size 1024` | Larger prompt-processing batches (faster on iGPUs) |
| `--jinja` | Proper chat template handling |
| `--mmproj <file>` | Auto-added when an `mmproj*.gguf` sibling is detected |
| `--alias <hf-repo>` | Auto-added for catalog models so `/v1/models` reports a stable HF id |
| `--no-mmap` | Opt-in via `noMmap: true` — only a measured win on Strix Halo / Ryzen AI MAX+ |

### Per-family sampler defaults

When the loaded model matches a curated entry in `src/catalog.ts`, locca
appends the family's vendor-recommended sampler so clients that don't set
their own values don't fall back to llama-server's generic temp 0.8:

| Family | Sampler |
|---|---|
| Qwen 3.5 / 3.6 ([Unsloth docs](https://unsloth.ai/docs/models/qwen3.6)) | `--temp 0.6 --top-k 20 --top-p 0.95 --min-p 0.0 --presence-penalty 0.0` |
| Gemma 4 (Google defaults) | `--temp 1.0 --top-k 64 --top-p 0.95 --min-p 0.0` |

Sideloaded GGUFs not in the catalog get no sampler injection — llama-server
uses its built-in defaults (or what `--jinja` reads from the GGUF metadata).
Any flag a client sets in its request still wins.

Per-model context auto-tuning (`ctxForModel()` in `src/models.ts`) picks
the largest tier that actually fits:

- **Catalog hit.** When the filename matches a curated entry in
  `src/catalog.ts`, locca uses each size's measured KV-cache slope plus
  detected RAM/VRAM to pick the largest tier from
  `[4k, 8k, 16k, 32k, 64k, 128k, 256k]` that fits.
- **Sideloaded GGUF.** Falls back to a name-based regex (MoE/`*A3B*` →
  128k; 3–9B → 128k; 12–14B → 64k; 22–27B → 32k; 30–35B → 64k; other →
  32k).
- **VRAM budget cap.** `vramBudgetMB` in your config caps the result so
  a small GPU doesn't OOM on the 128k default.

Sampling parameters (temperature, top_p, etc.) are read from GGUF
metadata when `--jinja` is on. Verify what your server is using with
`curl -s http://localhost:<port>/props | jq '.default_generation_settings.params'`.

## `locca bench`

Wraps `llama-bench -o json` and renders a friendlier summary:

```
  Generation     18.3 tok/s   ≈   14 words/sec    drives perceived speed
  Prompt eval   231.4 tok/s   ≈  178 words/sec    parallel, batched

  Translates to:
    • 200-token reply         10.9 s
    • 2000-token reply        1m 49s
    • 1000-token prompt eval   4.3 s  (time-to-first-token)
```

Generation rate is what you feel watching output stream; prompt-eval
rate sets time-to-first-token on long prompts.

While the bench runs, the spinner shows live stats — elapsed time, CPU
load, RAM, and (if `nvidia-smi` or `rocm-smi` is on PATH) GPU
utilisation and VRAM. The same line shows during the "pi is thinking"
wait in `locca optimise`.

## File layout

| Purpose | Path |
|---|---|
| Binary | wherever `npm` puts globals (`npm prefix -g`/bin) |
| Config | `~/.locca/config.json` |
| Server PID | `${XDG_RUNTIME_DIR:-/tmp}/locca-server.pid` |
| Server log | `${XDG_RUNTIME_DIR:-/tmp}/locca-server.log` |
| pi provider config | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` |
| Models dir | `~/.locca/models` (default, configurable) |
| Downloaded GGUFs | `$modelsDir/<repo>/` |

On Linux, runtime files live in `/run/user/$UID/` and are wiped on
reboot. That's intentional.

## Configuration

`locca setup` writes `~/.locca/config.json`. Edit it via `locca config`,
by hand, or re-run the wizard:

```json
{
  "modelsDir": "/home/you/.locca/models",
  "defaultPort": 8080,
  "defaultCtx": 32768,
  "defaultThreads": 10,
  "llamaServer": "llama-server",
  "llamaCli": "llama-cli",
  "llamaBench": "llama-bench",
  "piSkills": "lazy",
  "piExtensions": true,
  "piContextFiles": false,
  "vramBudgetMB": 16384,
  "defaultParallel": 1,
  "noMmap": false
}
```

The interactive editor shows preset pickers for `defaultCtx`,
`defaultThreads`, and `vramBudgetMB`, with a `Custom…` fallback.

If your binaries aren't on `$PATH`, point them at absolute paths:

```json
{
  "llamaServer": "/home/you/llama.cpp/build/bin/llama-server",
  "llamaCli":    "/home/you/llama.cpp/build/bin/llama-cli",
  "llamaBench":  "/home/you/llama.cpp/build/bin/llama-bench"
}
```

`piSkills` is tri-state (default `"lazy"`):

- `"lazy"` — `/skill:<name>` slash commands still work, but skill
  descriptions are stripped from the system prompt to save context on
  small local models. Implemented via a tiny bundled pi extension.
- `"on"` — pi's default; descriptions are loaded and the model can
  auto-invoke skills.
- `"off"` — passes `--no-skills`.

`piExtensions` (default `true`) toggles pi's extension discovery, needed
for `lazy` skills mode. `piContextFiles` (default `false`) toggles pi's
`AGENTS.md` / `CLAUDE.md` discovery; off by default so small models
aren't blown out by large project instruction files.

`vramBudgetMB` is optional. It caps the auto-picked context window:

| `vramBudgetMB` | Auto-ctx ceiling |
|---|---|
| ≤ 6 GB | 8 192 |
| ≤ 8 GB | 16 384 |
| ≤ 12 GB | 32 768 |
| ≤ 16 GB | 65 536 |
| > 16 GB | 131 072 |

It does **not** override an explicit `defaultCtx` or a ctx you type
into `locca serve`. `locca doctor` will detect your GPU's reported VRAM
and suggest a value if it's unset.

`noMmap` (default `false`) controls whether locca passes `--no-mmap` to
llama-server. Leave it off on dedicated-VRAM GPUs and Apple Silicon —
mmap is faster and lower-memory there. Flip it on for Strix Halo /
Ryzen AI MAX+ where one independent benchmark measured **+22% pp128 and
improved stability** with mmap disabled. Not auto-detected on purpose:
Strix Halo surfaces under several driver names
(`Radeon 8050S/8060S`, `Radeon Graphics`, `RADV STRIX_HALO`), so a wrong
guess would silently degrade.

locca probes `defaultPort` at startup. If something already responds to
`/health` (a llama-server you started by hand or via a supervisor),
locca marks it as **attached** and uses it instead of spawning a
duplicate. `serve`, `stop`, and `logs` short-circuit on attached
servers; manage them via whatever started them.

### `locca config`

```bash
locca config              # interactive picker
locca config list         # print every key + current value
locca config get  <key>
locca config set  <key> <value>
locca config reset <key>  # remove the key, fall back to defaults
locca config path
```

Empty values clear optional keys (e.g. `locca config set vramBudgetMB ""`
removes the cap).

## Dependencies

Required:

- `node` ≥ 20
- `llama.cpp`:
  - Arch: `sudo pacman -S llama.cpp` · `yay -S llama.cpp-vulkan-git` · `yay -S llama.cpp-hip-git`
  - macOS: `brew install llama.cpp`
  - Debian / Ubuntu / Fedora / openSUSE / Alpine: build from source.
    `locca setup` prints the exact `apt`/`dnf`/`zypper`/`apk` line; full
    deps reference at
    [`.claude/skills/llama-cpp-manage/references/install.md`](.claude/skills/llama-cpp-manage/references/install.md).

Optional:

- `pi` ([pi.dev](https://pi.dev)) for the `locca pi` subcommand. The
  setup wizard offers to install it, or:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  # or
  mise use -g npm:@mariozechner/pi-coding-agent
  ```
- `vulkan-tools` — `vulkaninfo` for GPU diagnostics.
- `rocm-smi-lib` — VRAM monitoring on AMD discrete GPUs.
- `jq` — used by `diagnose.sh` for prettier output.

## Updating

```bash
npm update -g @zeiq/locca
```

Or, if installed from source:

```bash
cd path/to/locca
git pull
npm install
npm run build
```

## Uninstall

```bash
npm uninstall -g @zeiq/locca
rm -rf "$HOME/.locca"                                   # config + models (optional)
rm -rf "$HOME/.pi/agent"                                # pi provider config (optional)
rm -f "${XDG_RUNTIME_DIR:-/tmp}/locca-server."{pid,log}
```

## License

MIT
