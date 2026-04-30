---
name: llama-cpp-manage
description: Install, configure, troubleshoot, and operate llama.cpp on Linux or macOS — covers source builds (Debian/Ubuntu apt deps, Arch pacman, Fedora/openSUSE/Alpine, macOS brew), GPU backend selection (Vulkan / Metal / ROCm / CUDA), server lifecycle (port conflicts, health probes, detached vs foreground), pi-coding-agent integration via `~/.pi/agent/models.json`, and per-model tuning (ctx, sampling, vision mmproj, GGUF metadata). USE THIS SKILL whenever the user mentions llama-server, llama-cli, llama-bench, llama.cpp build errors, "my model won't load", "the server failed to start", GGUF files, an OpenAI-compatible local server, port conflicts on 8080/8081, or trouble with the pi coding agent against a local model — even if they don't say "llama.cpp" by name. The user's primary CLI is pi-llm; treat it as the frontend and llama.cpp as the runtime it manages.
---

# llama.cpp on Linux / macOS — operations runbook

This skill is the institutional knowledge that goes alongside [pi-llm](../../..) — the TUI that runs llama.cpp, manages models, and launches the `pi` coding agent against a local server. pi-llm handles the happy path; this skill is the runbook for *everything else*: installation, troubleshooting, tuning, and integration with adjacent tools.

## When you're helping the user

Before changing anything, get a clean read on **state** (what's installed, what's running). The most useful starting points:

```bash
pi-llm status           # server source (pid/external/attached), llama.cpp path, models dir
pi-llm api              # if a server is up, get URL + LAN/Tailscale URLs + endpoints
which llama-server      # is the binary on PATH, and where?
ss -tlnp | grep ':8081' # is something else on the port?
```

Hit `/health`, `/props`, and `/slots` directly when you need ground truth (`pi-llm status` already does `/props` for ctx + slot count, but you may want raw data):

```bash
curl -s http://127.0.0.1:8081/health
curl -s http://127.0.0.1:8081/props | jq '.default_generation_settings.params | {n_ctx, temperature, top_p, top_k, min_p}'
curl -s http://127.0.0.1:8081/slots
```

Logs for a pi-llm-managed server:

```bash
tail -f "${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.log"   # or: pi-llm logs
```

## Installing llama.cpp

The right path depends on the distro. **Default: build from source with Vulkan** unless the user is on Arch (where `pacman -S llama.cpp` is a one-liner) or macOS (where `brew install llama.cpp` is). Vulkan is the most universal GPU backend on AMD / Intel / NVIDIA — use Metal on macOS, ROCm only when the user has a discrete AMD GPU and asks for it specifically.

See `references/install.md` for the full per-distro deps matrix. Quick reference:

| Distro | Easy path | Source-build deps |
|---|---|---|
| Arch | `sudo pacman -S llama.cpp` | base-devel + vulkan-headers + glslang + curl |
| Debian / Ubuntu | (no package) — build from source | `cmake build-essential pkg-config libvulkan-dev glslc glslang-tools spirv-headers libcurl4-openssl-dev` |
| Fedora | (no package) — build from source | `cmake gcc-c++ make pkgconf vulkan-headers vulkan-loader-devel glslang libcurl-devel` |
| openSUSE | (no package) | similar to Fedora |
| Alpine | (no package) | `cmake build-base pkgconfig vulkan-headers vulkan-loader-dev glslang curl-dev` |
| macOS | `brew install llama.cpp` | `cmake` for source builds (Metal default) |

Source build (Vulkan, the typical path on Debian/Ubuntu/Fedora):

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cmake -B ~/llama.cpp/build -S ~/llama.cpp -DGGML_VULKAN=ON
cmake --build ~/llama.cpp/build -j
export PATH="$HOME/llama.cpp/build/bin:$PATH"                  # this session
echo 'export PATH="$HOME/llama.cpp/build/bin:$PATH"' >> ~/.bashrc   # persist
```

`pi-llm setup` already renders the right install hint per detected distro — if the user is fresh, prefer running that over hand-typing instructions. If they hit a build error, see `references/install.md` for the gotchas.

### Common build errors and fixes

These come up reliably on Debian/Ubuntu source builds:

| Error | Missing | Fix |
|---|---|---|
| `cmake: command not found` | cmake | `sudo apt install -y cmake build-essential` |
| `Could NOT find Vulkan (missing: glslc)` | shaderc binary | `sudo apt install -y glslc` |
| `fatal error: spirv/unified1/spirv.hpp` | SPIRV headers | `sudo apt install -y spirv-headers` |
| `fatal error: vulkan/vulkan.h` | Vulkan dev headers | `sudo apt install -y libvulkan-dev` |
| `Could NOT find CURL` | curl dev | `sudo apt install -y libcurl4-openssl-dev` |
| `cc1plus: error: unknown ... -march=native` | wrong build platform | rebuild on the deploy host (don't transplant binaries across CPU families) |

If the user gets one and we fix it, the build picks up where it left off — `cmake --build ~/llama.cpp/build -j` again is enough; no clean needed.

## When llama-server fails to start

Three frequent causes, in order of likelihood:

**1. Port already in use.** llama-server's bind error reads `couldn't bind HTTP server socket, hostname: 127.0.0.1, port: <N>`. Check:

```bash
ss -tlnp | grep ':<port> '
curl -sI http://127.0.0.1:<port>/   # often reveals the conflicting service via Server header / page title
```

Port 8080 is a frequent collision because many self-hosted apps default to it. Fix by changing pi-llm's `defaultPort` in `~/.config/pi-llm/config.json` to a free port (8081 and 18080 are common alternatives). pi-llm has a preflight check (`refuseIfPortTaken` in `src/preflight.ts`) that names the conflicting service via its Server header / page `<title>` — but only fires *before* spawning, so a llama-server that crashed mid-startup won't show this.

**2. Source build is broken / out of date.** The `build_info` line in the log starts with `b<NNNN>-<commit>` — if it's months old and `git log --oneline -1` in `~/llama.cpp` shows the source has moved on, rebuild:

```bash
cd ~/llama.cpp && git pull && cmake --build build -j
```

**3. Missing GPU drivers.** Vulkan needs the Mesa driver on AMD/Intel, the proprietary driver on NVIDIA. Check:

```bash
vulkaninfo --summary 2>&1 | head -20    # should list at least one GPU
ls /dev/dri/                             # renderD128 = AMD/Intel iGPU
```

No GPU listed → fall back to CPU build by re-running cmake without `-DGGML_VULKAN=ON`, or install the Vulkan driver (`mesa-vulkan-drivers` on Debian).

## When pi can't see the model

pi 0.70+ removed the built-in `--provider llamacpp` flag. Local OpenAI-compatible servers are now registered as a **custom provider** in `~/.pi/agent/models.json`. pi-llm writes this file automatically before launching pi, but if pi reports `Unknown provider "llamacpp"` from a script bypassing pi-llm, the registration is missing.

Minimal valid `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "pi-llm": {
      "name": "pi-llm (local llama.cpp)",
      "baseUrl": "http://127.0.0.1:8081/v1",
      "api": "openai-completions",
      "apiKey": "unused",
      "models": [
        {
          "id": "<exact-filename-from-/v1/models>",
          "name": "<friendly>",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then `pi --model pi-llm/<model-id>`. The `id` must match what `curl http://127.0.0.1:8081/v1/models | jq '.data[0].id'` returns — usually the full GGUF filename.

If the user has *other* providers registered, only touch the `pi-llm` key — that's the one pi-llm owns. See `src/pi-config.ts` in the pi-llm source for the canonical writer.

## Server lifecycle modes

pi-llm has three ways the server can be running, exposed in `pi-llm status` as the `source` field:

| Source | Meaning | `pi-llm stop` | `pi-llm serve` |
|---|---|---|---|
| `pid` | pi-llm spawned and tracks the PID | works | refuses (server already running) |
| `external` | `serverUrl` is set in config; pi-llm only talks to it | refuses (not ours) | refuses (would conflict) |
| `attached` | something else (a manually started llama-server, another supervisor) is on the local port — pi-llm probed `/health` and uses it as a read-only client | refuses (not ours) | refuses (port taken) |

The most surprising one is `attached`. If a llama-server is already running on pi-llm's `defaultPort` (started by hand, by another supervisor, or by an external tool), pi-llm will *attach* to it and `pi-llm pi` works without spawning a duplicate that would fight for VRAM. To swap to a pi-llm-spawned server, the existing one has to be stopped first by whatever started it.

For an externally-managed server on a different port or another host, set `serverUrl` in `~/.config/pi-llm/config.json`:

```json
{ "serverUrl": "http://localhost:8081" }
```

This switches pi-llm into external-mode for *all* commands; `serve`/`stop`/`logs` start refusing because there's nothing for them to do.

## Foreground vs detached

`pi-llm serve` runs llama-server **detached** by default (writes to log file, exits with the PID). This is intentional — Ctrl-C'ing pi-llm doesn't kill the server. To stop, use `pi-llm stop`. To watch logs, use `pi-llm logs` (which tails `${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.log`).

If the user complains "the server stops when I close my terminal" they're probably running llama-server directly; suggest `pi-llm serve` or wrap their command in `nohup`/`systemd`.

## Per-model tuning

pi-llm picks reasonable defaults but several knobs matter for quality on a given GPU:

### Context window

`src/models.ts:ctxForModel()` sets ctx by parameter count regex:

| Class | Auto ctx |
|---|---|
| MoE / `*A3B*` | 131072 (128k) |
| 30–35B dense | 65536 (64k) |
| 22–27B dense | 32768 (32k) |
| 12–14B dense | 65536 (64k) |
| 3–9B dense | 131072 (128k) |
| Other / unrecognised | 32768 (default) |

Bigger ctx = larger KV cache = more VRAM. q8_0 KV cache (pi-llm's default) is 4× smaller than f16 — that's the only reason 128k fits on a 16GB iGPU for an 8B model. If the user OOMs, halving ctx is the first lever, then dropping to a smaller quant.

If a model isn't getting matched correctly, check `src/models.ts` — the regex uses negative lookahead/lookbehind to avoid e.g. "9B" matching "32B" via substring. Add a new bucket if needed.

### Sampling parameters

llama-server reads sampling defaults from the **GGUF metadata** when `--jinja` is on (pi-llm always sets it). For example, Gemma 4 GGUFs embed `temp=1.0, top_p=0.95, top_k=64` and llama-server picks those up — pi-llm doesn't override. The user can verify via `/props`:

```bash
curl -s http://127.0.0.1:8081/props | jq '.default_generation_settings.params | {temperature, top_p, top_k, min_p}'
```

If a model card recommends different sampling, the user has two options: (1) override per-request in their client, or (2) modify the GGUF metadata with `gguf-py` (rare, only worth it for self-hosted finetunes).

### Vision (mmproj)

Multimodal models (Gemma 4, Llava, Bakllava, etc.) ship a separate `mmproj-*.gguf` projector file. Drop it as a sibling in the same directory as the main GGUF and pi-llm auto-detects (see `scanModels` in `src/models.ts`) — it tags the model with `[vision]` in pickers and passes `--mmproj <path>` to llama-server.

If the user downloaded only the main file, vision won't work. `pi-llm download <repo>` shows the mmproj as an optional second download.

## Useful files in the pi-llm source

When debugging behaviour, these are the load-bearing files:

| File | What's there |
|---|---|
| `src/server.ts` | `serverStatus()` (the source-detection logic), `launchServer()`, `waitReady()` (uses `/health`), `probeServer()`, `isPortInUse()`, `describePortOccupant()` |
| `src/preflight.ts` | The "port taken by another service" error (names the conflicting service via Server header / page title) |
| `src/models.ts` | `scanModels()` (ggml-vocab and mmproj filtering), `ctxForModel()` |
| `src/pi-config.ts` | Writes `~/.pi/agent/models.json` |
| `src/distro.ts` | Detects distro from `/etc/os-release` and renders apt/pacman/dnf install hints |
| `src/commands/*.ts` | Each subcommand (serve, pi, switch, status, bench, …) |

## Diagnostic commands

When in doubt, run the bundled `scripts/diagnose.sh` for a one-shot health snapshot covering distro, llama.cpp binaries, pi-llm config, server `/health` + `/v1/models` + `/props`, PID file state, models dir size, pi agent registration, and Vulkan device list. It's read-only — never starts or stops anything.

The script lives next to this `SKILL.md`; run it with the absolute path the skill was loaded from, or copy-paste the relevant pieces inline. The full set of probes it does (in order):

1. `/etc/os-release` for distro detection
2. `command -v llama-server` etc. for binary discovery
3. `~/.config/pi-llm/config.json` parse via `jq`
4. `curl /health`, `/v1/models`, `/props` on the configured port
5. `ss -tln` if /health fails — to see if a non-llama service is squatting the port
6. `${XDG_RUNTIME_DIR}/pi-llm-server.pid` for managed-server status
7. Models dir count + size
8. `~/.pi/agent/models.json` providers list
9. `vulkaninfo --summary` for GPU detection

If you don't have the script handy, the same probes run by hand will surface the same issues.
