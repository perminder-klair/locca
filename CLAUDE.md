# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / run

- `npm run build` — `tsc` → `dist/`. The published `bin/locca` shim just imports `dist/cli.js`, so **a build is required for any source change to take effect**.
- `npm run dev` — `tsc --watch`.
- `npm start` — runs `node bin/locca` (uses whatever's already in `dist/`).
- `npm link` — install the CLI globally from a checkout for end-to-end testing.
- `npm test` — builds, then runs `node:test` unit tests in `test/unit/*.test.js`. Tests import from `dist/`, so they exercise the compiled output (no ts-node/tsx dependency).
- `npm run lint` / `npm run lint:fix` — Biome (config in `biome.json`). CI (`.github/workflows/ci.yml`) runs lint + test on push/PR, so run both before committing.
- `tsconfig.json` runs `strict: true`.

## Architecture

Single-binary TypeScript ESM CLI (`type: "module"`, `module: NodeNext`). All `.js` import specifiers in source are intentional — they target compiled output.

`src/cli.ts` is a thin dispatcher: it parses `argv[2]` and **dynamically imports** the matching `src/commands/*.ts` module so cold-path commands don't pay a startup cost. With no args it falls through to `src/setup.ts` (first run) → `src/menu.ts` (Clack TUI). Every new subcommand needs both a `cli.ts` `case` and (usually) a `menu.ts` entry.

### Server lifecycle — `src/server.ts`

Every command that needs an LLM calls `serverStatus(cfg)`, which classifies the running server into one of two sources. **This distinction drives almost every decision elsewhere**:

| `source`   | Meaning                                                  | Allowed to stop? |
|------------|----------------------------------------------------------|------------------|
| `pid`      | locca spawned it (PIDFILE in `$XDG_RUNTIME_DIR`)        | yes              |
| `attached` | No PIDFILE, but `/health` responds on `cfg.defaultPort`  | no               |

`attached` is the "a `llama-server` started outside locca (by hand, another supervisor, another tool) is already on the port" case — locca uses it but refuses to manage it. `stop` short-circuits when source is `attached`.

`refuseIfPortTaken()` (`src/preflight.ts`) runs *after* `serverStatus()` and only fires when the port is occupied by something that does **not** answer `/health` — i.e. a non-llama service. Don't reorder these: `serverStatus` must run first so the "attached" case isn't misreported as a conflict.

`buildServerArgs()` bakes in flags tuned for AMD Strix Halo / Radeon 890M (Vulkan, `--n-gpu-layers 999`, `--flash-attn on`, q8_0 KV cache, `--parallel` from `cfg.defaultParallel` (default 1) — `--cache-reuse 256`, `--batch-size 1024`, `--jinja`). If a sibling `mmproj*.gguf` is detected, `--mmproj` is auto-injected.

`waitReady()` polls `/health`, **not** `/v1/models` — `/health` flips green when the HTTP listener binds, while `/v1/models` only answers post-weights-load. On big models that's a 10–30s gap that previously caused spurious timeouts.

`launchServer()` returns the `ChildProcess` and runs in one of two modes. **Detached** (the default for `serve`/`embed`): stdio to the logfile, `child.unref()`, PIDFILE written, locca exits leaving the server up. **Foreground** (`detached: false` → `stdio: 'inherit'`): locca stays attached. `serve -f` is the only foreground caller — `superviseForeground()` (`src/commands/serve.ts`) forwards SIGTERM/SIGINT to the child, removes the PIDFILE, and exits with the server's exit code, which is the shape a container's PID 1 / a systemd unit needs. `serve` also treats **no TTY** as non-interactive (resolve the named or sole chat model, never block on the Clack picker) so it can't hang head-less.

### Model discovery & context tuning — `src/models.ts`

`scanModels()` walks `cfg.modelsDir` recursively, skipping `mmproj*.gguf` (vision adapters, attached to their parent model) and `ggml-vocab-*.gguf` (llama.cpp tokenizer fixtures, no weights).

`ctxForModel(name)` picks an auto-context based on regex matches against the model name. **Order matters** — bigger sizes are tested first, and the regexes use lookarounds so e.g. `Qwen3.5-9B` doesn't match `32B`. Edit this when tuning for a different VRAM budget.

### Eve integration

`src/commands/agent.ts` selects or attaches to inference and starts the detached
`src/agent-service.ts` process. The service starts the packaged `.output/server/index.mjs`
from the agent data directory so Eve workflow state persists outside the npm
installation. `npm run build` builds both the CLI and Eve output. Include `.output`
and `web` in the published package; an unbuilt checkout cannot start an agent.

`agent/` owns instructions, the direct AI SDK provider, and tools. Read the installed
`node_modules/eve/docs/README.md` and the relevant guide before changing Eve APIs.
`src/local-provider.ts` preloads an AI SDK provider registry in the isolated Eve
process before its workflow modules. Only the `locca/` namespace resolves, through
a direct OpenAI-compatible provider. Dynamic session/turn selections persist that
local ID and the live context window. Keep this preload: without it, string IDs
would use AI Gateway. Step-only provider objects cannot support manual compaction
in the pinned Eve release because there is no durable model selection between turns.

`src/agent-store.ts` stores workspace attachments, conversation titles and recurring
jobs in SQLite. Eve owns the durable conversation events and workflow state. Do not
replace Eve's session protocol with an independent agent loop or transcript store.

`web/events.js` reduces durable events for browser replay and live updates. Preserve
request IDs and authoritative input resolution events when changing approval UI.
The browser never receives the internal Eve token. Its own loopback API uses a
private login token, an HttpOnly cookie, and host/origin validation.

File tools operate in the conversation's explicitly selected host workspace.
`src/workspace.ts` validates relative paths and symlink containment. Bash is a
host tool requiring approval, not a Docker sandbox. Keep its environment scoped
and propagate timeout/cancellation to command processes.

`locca stop` stops the agent before inference. `stopServer` rejects chat-server
changes while the agent service runs. Model calls are serialized across sessions;
changing this must account for llama.cpp slot context and memory use.

The integration tests exercise the real built Eve service with a local deterministic
OpenAI-compatible fixture. Run them after session, approval, service lifecycle,
provider, or workspace changes. The fixture is test-only and never selects a
production model.

### Config — `src/config.ts`

`~/.locca/config.json`. Written with `mode 0o600`. `loadConfig()` merges over `defaults()` so older configs missing newer keys keep working without migration. After the merge, `LOCCA_MODELS_DIR` (if set) overrides `modelsDir` — the escape hatch for containers / environments with no config file to edit (the Docker image sets it to `/models`). `saveConfig()` merges over the *raw file contents* (`readConfigFile()`), never over `loadConfig()` — merging over the resolved view would persist that env override into config.json.

### Downloads — `src/hf.ts`

`downloadFile()` streams into `<dest>.part` and renames on success — an interrupted download never leaves a truncated `.gguf` for `scanModels()` to find. A leftover `.part` is resumed with a `Range` request (a 200 instead of a 206 means the Range was ignored → restart from 0). Received bytes are verified against the advertised total before the rename. `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` (if set) are sent on every HF request for gated repos. File paths are encoded per-segment (`encodeHfPath`) so subfoldered GGUFs resolve.

### Distro detection — `src/distro.ts`

Drives only the install hints shown by `requireLlama()` and the setup wizard — it does *not* gate behavior. Adding a new distro means adding a `case` in `llamaInstallHint()`; the rest of the codebase doesn't care.

## Conventions worth knowing

- All user-facing output goes through `@clack/prompts` (`p.log.*`, `p.spinner`, `p.select`, …) or `picocolors` via `src/ui.ts`. Don't `console.log` raw colors — use `pc.*`.
- `exitIfCancelled()` (in `src/ui.ts`) must wrap every Clack prompt result before use — it narrows away the `symbol` cancel sentinel and exits cleanly on Ctrl-C.
- Runtime files (PID, log) live under `$XDG_RUNTIME_DIR` (falls back to `/tmp`). On Linux that's `/run/user/$UID/`, wiped on reboot — intentional.
- `have(cmd)` / `which(cmd)` in `src/util.ts` are the project's own PATH lookup — don't shell out to `which`.
