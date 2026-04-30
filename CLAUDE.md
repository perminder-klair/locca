# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / run

- `npm run build` — `tsc` → `dist/`. The published `bin/pi-llm` shim just imports `dist/cli.js`, so **a build is required for any source change to take effect**.
- `npm run dev` — `tsc --watch`.
- `npm start` — runs `node bin/pi-llm` (uses whatever's already in `dist/`).
- `npm link` — install the CLI globally from a checkout for end-to-end testing.
- No test runner, no linter, no formatter is configured. `tsconfig.json` runs `strict: true`.

## Architecture

Single-binary TypeScript ESM CLI (`type: "module"`, `module: NodeNext`). All `.js` import specifiers in source are intentional — they target compiled output.

`src/cli.ts` is a thin dispatcher: it parses `argv[2]` and **dynamically imports** the matching `src/commands/*.ts` module so cold-path commands don't pay a startup cost. With no args it falls through to `src/setup.ts` (first run) → `src/menu.ts` (Clack TUI). Every new subcommand needs both a `cli.ts` `case` and (usually) a `menu.ts` entry.

### Server lifecycle — `src/server.ts`

Every command that needs an LLM calls `serverStatus(cfg)`, which classifies the running server into one of three sources. **This distinction drives almost every decision elsewhere**:

| `source`   | Meaning                                                  | Allowed to stop? |
|------------|----------------------------------------------------------|------------------|
| `pid`      | pi-llm spawned it (PIDFILE in `$XDG_RUNTIME_DIR`)        | yes              |
| `external` | `cfg.serverUrl` is set and reachable                     | no               |
| `attached` | No PIDFILE, but `/health` responds on `cfg.defaultPort`  | no               |

`attached` is the "docker compose container or manual `llama-server` is already on the port" case — pi-llm uses it but refuses to manage it. `stop`/`serve`/`logs` short-circuit when source is `external` or `attached`.

`refuseIfPortTaken()` (`src/preflight.ts`) runs *after* `serverStatus()` and only fires when the port is occupied by something that does **not** answer `/health` — i.e. a non-llama squatter (qBittorrent, Jupyter…). Don't reorder these: `serverStatus` must run first so the "attached" case isn't misreported as a conflict.

`buildServerArgs()` bakes in flags tuned for AMD Strix Halo / Radeon 890M (Vulkan, `--n-gpu-layers 999`, `--flash-attn on`, q8_0 KV cache, `--parallel 1`, `--cache-reuse 256`, `--batch-size 1024`, `--jinja`). If a sibling `mmproj*.gguf` is detected, `--mmproj` is auto-injected.

`waitReady()` polls `/health`, **not** `/v1/models` — `/health` flips green when the HTTP listener binds, while `/v1/models` only answers post-weights-load. On big models that's a 10–30s gap that previously caused spurious timeouts.

### Model discovery & context tuning — `src/models.ts`

`scanModels()` walks `cfg.modelsDir` recursively, skipping `mmproj*.gguf` (vision adapters, attached to their parent model) and `ggml-vocab-*.gguf` (llama.cpp tokenizer fixtures, no weights).

`ctxForModel(name)` picks an auto-context based on regex matches against the model name. **Order matters** — bigger sizes are tested first, and the regexes use lookarounds so e.g. `Qwen3.5-9B` doesn't match `32B`. Edit this when tuning for a different VRAM budget.

### Pi integration — `src/commands/pi.ts` + `src/pi-config.ts`

Pi 0.70+ removed `--provider llamacpp` and now requires custom OpenAI-compatible servers to be registered in `~/.pi/agent/models.json`. `ensurePiModelsJson()` rewrites the `pi-llm` provider entry on every launch so the model id and `baseUrl` always match the live server. **Do not touch other providers in that file** — only the `pi-llm` key is owned by us.

The `pi` command branches on three states: external server (use as-is, ignore any model pattern), attached server (use the model it reports, warn if it doesn't match the user's pattern), or local mode (spawn/switch via `launchServer()` + `waitReady()`).

### Config — `src/config.ts`

`~/.config/pi-llm/config.json` (or `$XDG_CONFIG_HOME/pi-llm/`). Written with `mode 0o600`. `loadConfig()` merges over `defaults()` so missing keys (e.g. older configs that predate `serverUrl`) keep working without migration. The `serverUrl` field is the kill switch that turns on external mode globally.

### Distro detection — `src/distro.ts`

Drives only the install hints shown by `requireLlama()` and the setup wizard — it does *not* gate behavior. Adding a new distro means adding a `case` in `llamaInstallHint()`; the rest of the codebase doesn't care.

## Conventions worth knowing

- All user-facing output goes through `@clack/prompts` (`p.log.*`, `p.spinner`, `p.select`, …) or `picocolors` via `src/ui.ts`. Don't `console.log` raw colors — use `pc.*`.
- `exitIfCancelled()` (in `src/ui.ts`) must wrap every Clack prompt result before use — it narrows away the `symbol` cancel sentinel and exits cleanly on Ctrl-C.
- Runtime files (PID, log) live under `$XDG_RUNTIME_DIR` (falls back to `/tmp`). On Linux that's `/run/user/$UID/`, wiped on reboot — intentional.
- `have(cmd)` / `which(cmd)` in `src/util.ts` are the project's own PATH lookup — don't shell out to `which`.
