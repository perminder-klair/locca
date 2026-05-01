# locca

A TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp) for running,
managing, and benchmarking local GGUF models and launching the
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
2. Confirms `llama-server` is on `$PATH`. If not, prints the exact install
   line for your distro at the end.
3. Sets **server defaults** (port / ctx / threads / VRAM budget tier).
4. If your models dir is empty, offers a **catalog-aware first model
   picker** — every curated size shows a `fits — 5.6 GB dl, 14.3 GB RAM,
   256k ctx` (or `needs 32 GB+ RAM`) hint based on your detected hardware,
   so you can't accidentally pick a 30 GB download that won't run.
5. Offers to install `pi`: tries `mise` → `npm` → manual hint.

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
locca switch                   # catalog-aware picker: installed models + curated catalog
locca bench                    # run llama-bench against a model
locca doctor                   # health check: hardware, llama.cpp, server, log, config
locca optimise                 # ask pi to review the deployment and suggest tweaks
locca api                      # print OpenAI-compatible connection info
locca logs                     # tail server log (pi-started servers only)
locca download [user/repo]     # pull a GGUF from HuggingFace (catalog-aware recommendation)
locca search   [query]         # search HuggingFace for GGUF models
locca delete                   # remove a model directory
locca stop                     # stop the running server
locca config                   # view / edit ~/.locca/config.json
locca setup                    # re-run the setup wizard
locca help                     # full command listing
```

`locca pi qwen` will fuzzy-match the first `*qwen*.gguf` in your models dir.

## Health checks — `locca doctor` & `locca optimise`

`locca doctor` runs a read-only sweep and prints what it finds:

- **Hardware** — CPU count, total/free RAM, GPUs (probed via `nvidia-smi`,
  `rocm-smi`, `vulkaninfo`, or `system_profiler` on macOS) with VRAM totals
  where vendor tools expose them.
- **llama.cpp** — resolved binary path and `--version` banner.
- **Server** — running state (none / `pid` / `attached`), live `n_ctx` and
  `n_ctx_train` from `/props`.
- **Models** — count and total size in `modelsDir`.
- **pi** — installed? `~/.pi/agent/models.json` present? `locca` provider
  registered?
- **Server log** — scans the last 64 KiB for known patterns: outdated chat
  templates, jinja render failures, OOMs, context truncation, `cache_reuse`
  fall-backs, speculative-decoding warnings.
- **Findings** — info / warning / error rows with concrete suggestions
  (e.g. *"defaultThreads (16) > cpu count (12) — drop to 10"*).

`locca optimise` (alias `optimize`) bundles the same data into a markdown
prompt and pipes it to **pi** running against your local model — it'll
spin up a small model from `modelsDir` if nothing's serving, then ask pi
to call out the biggest issue and rank 3–5 concrete tweaks. Useful when
the heuristics in `doctor` aren't enough and you want a model to look at
the whole picture.

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

Per-model context auto-tuning (`ctxForModel()` in `src/models.ts`) picks
the largest tier that actually fits your machine:

- **Catalog hit.** When the filename matches a curated entry in
  `src/catalog.ts` (Gemma 4, Qwen 3.5, Qwen 3.6, …), locca uses each
  size's measured KV-cache slope plus your detected RAM/VRAM to pick the
  largest tier from `[4k, 8k, 16k, 32k, 64k, 128k, 256k]` that fits.
- **Sideloaded GGUF.** Falls back to a name-based regex heuristic
  (MoE/`*A3B*` → 128k; 3–9B → 128k; 12–14B → 64k; 22–27B → 32k; 30–35B
  → 64k; other → 32k).
- **VRAM budget cap.** `vramBudgetMB` in your config (see below) caps the
  result so a small GPU doesn't OOM on the 128k default.

Bigger ctx = larger KV cache = more VRAM. q8_0 KV cache is what makes 128k
feasible on a shared-VRAM iGPU.

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

## Configuration

`locca setup` writes `~/.locca/config.json`. Edit it via the `locca config`
command, by hand, or re-run the wizard:

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
  "piSkills": false,
  "piExtensions": false,
  "piContextFiles": false,
  "vramBudgetMB": 16384
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

`piSkills` / `piExtensions` / `piContextFiles` (all default `false`) flip
pi's built-in skill dispatch, extensions, and `AGENTS.md` / `CLAUDE.md`
context-file discovery on or off. The defaults are off so small local models
aren't blown out by skills or large project instruction files; turn them on
if you want pi's full project-aware surface against a capable model.

`vramBudgetMB` is optional — an approximate VRAM hint (in MB) that caps the
context window `ctxForModel()` will auto-pick. Without it, big models
default to 128k ctx and may OOM at load time on smaller GPUs. The cap is
tier-based:

| `vramBudgetMB` | Auto-ctx ceiling |
|---|---|
| ≤ 6 GB | 8 192 |
| ≤ 8 GB | 16 384 |
| ≤ 12 GB | 32 768 |
| ≤ 16 GB | 65 536 |
| > 16 GB | 131 072 |

It does **not** override an explicit `defaultCtx` or a ctx you type into
`locca serve`. `locca doctor` will detect your GPU's reported VRAM and
suggest a value if it's unset.

locca probes the configured `defaultPort` at startup. If something already
responds to `/health` (a llama-server you started outside locca, by hand or
via a supervisor), locca marks it as **attached** and uses it instead of
spawning a duplicate. `serve`, `stop`, and `logs` short-circuit on
attached servers — manage them via whatever started them.

### Editing config — `locca config`

```bash
locca config              # interactive picker — view & edit any key
locca config list         # print every key + current value
locca config get  <key>   # print one value
locca config set  <key> <value>   # update one key
locca config reset <key>  # remove the key, fall back to defaults
locca config path         # print the path to config.json
```

Empty values clear optional keys (e.g. `locca config set vramBudgetMB ""`
removes the cap and falls back to no auto-ctx clamp).

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
