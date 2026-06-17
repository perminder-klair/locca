# Design: `locca serve --idle-timeout` — idle VRAM unload + reload-on-demand

Date: 2026-06-17
Issue: https://github.com/perminder-klair/locca/issues/13
Status: approved

## Problem

`llama-server` keeps model weights resident in VRAM for its whole lifetime —
there is no native "unload when idle, reload on demand" flag. locca's default
`serve` path spawns `llama-server` detached and then **exits**, so there is no
resident locca process to watch idle time or to catch the request that should
trigger a reload.

The reporter wants a flag to free VRAM after the model sits unused for a
configurable period (e.g. 15 min), reloading it transparently on the next
request.

## Solution overview

Add `locca serve <model> --idle-timeout <duration>`: a **foreground**
reverse-proxy supervised by locca itself. It loads the model eagerly (serve
still serves), proxies inference to a private `llama-server`, and after the
model sits idle for the timeout it stops `llama-server` to free VRAM. The next
inference request cold-starts the model and forwards once ready.

Foreground-only by explicit decision — it keeps the surface small and is the
right shape for containers/systemd. Desktop users background it themselves
(`nohup`/`&`/tmux). No detached daemon, no `locca stop`/menu integration in v1.

## Architecture

One new module, `src/proxy.ts`. `serve.ts` wires the flag to it.

```
client → proxy :PORT (0.0.0.0)  ──forwards──▶  llama-server 127.0.0.1:PORT+1
              │                                        ▲
              ├─ idle > timeout & no in-flight ──────► SIGTERM (VRAM freed)
              └─ inference request while down ───────► spawn + waitReady, then forward
```

### Ports
- Proxy binds the user-facing port (`--port` / `cfg.defaultPort`) on host
  `0.0.0.0` — so LAN / Tailscale work exactly as today.
- `llama-server` moves to `port + 1`, bound to `127.0.0.1` only (internal, not
  LAN-exposed).
- If `port + 1` is already taken at startup, refuse with a clear message.

### Reuse from `server.ts`
- `buildServerArgs()` to construct the `llama-server` argv (varying only
  host/port per respawn).
- `waitReady()` to poll `/health` after each (re)launch.
- The same `ServeOpts` `serve.ts` already computes — `ctx`, `threads`,
  `noMmap`, `parallel`, `mmproj`, and `extraArgs` (`serverArgsForModel` +
  `mtpArgsForModel`) — so a respawned model is byte-identical to the original
  launch. `serve.ts` builds the `ServeOpts` once and hands them to the proxy.

## Request routing

| Endpoint | Cold-starts? | Resets idle? | When model is down |
|---|---|---|---|
| `GET /health` | no | no | proxy returns `200` (service up, just cold) |
| `GET /v1/models` | no | no | synthesized list with the served model id |
| `GET /props`, `GET /metrics` | no | no | proxy-through if up, else minimal / `503` |
| everything else (inference) | **yes** | **yes** | held open → cold-start → forward |

Only real inference resets the idle timer, so a Docker healthcheck or a status
poll cannot keep the model pinned in VRAM.

## Concurrency & lifecycle

- State machine: `down → starting → up → stopping`. A single `ensureUp()`
  promise — concurrent requests during a cold start all await the **one**
  spawn; the model is never double-launched.
- Idle reaper runs on an interval (every few seconds). It unloads only when
  `inFlight === 0 && now - lastActivity > timeout` — an in-flight stream is
  never cut mid-generation.
- Request body is buffered in memory (chat/vision bodies are small for a
  single-user local server) so it survives the cold-start wait. The response is
  **streamed** through untouched, so SSE generations pass straight back.
- The proxy's own response timeout is disabled so long generations and cold
  starts are not severed.
- Cold-start failure (model won't load): held requests get `503` with the
  error; state resets so a later request retries.
- `llama-server` crash while up: detected via child `exit`; marked down; the
  next inference request reloads.
- Ctrl-C / SIGTERM: stop `llama-server` (if up), then exit.

## CLI surface

- New flag: `--idle-timeout <duration>` (also `--idle-timeout=<duration>`).
- Duration parsing: `30s`, `15m`, `1h`, or a bare integer (= seconds). Invalid
  values are rejected with a clear message.
- `--idle-timeout` implies the foreground proxy mode (it cannot detach).
- `cli.ts` help text and README gain a short note, including the cold-start
  latency caveat.

## Caveat (documented)

The first request after an unload pays the weights-load latency (10–30s on big
models, per `waitReady`'s own comment). The proxy holds the connection open
during the load; clients with aggressive timeouts may abandon that first cold
request.

## Scope

**In:** the flag, `src/proxy.ts`, `serve.ts` wiring, `cli.ts` help text, README
note.

**Out (v1):** detached daemon mode; `locca stop` / interactive-menu
integration; embedding-sidecar management under the proxy (foreground serve
does not manage it today either); a persistent `idleTimeout` config key
(flag-only for v1).
