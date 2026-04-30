#!/usr/bin/env bash
# llama.cpp / pi-llm diagnostic snapshot.
# Read-only — never starts or stops anything. Run when something feels off
# and you want a single dump of relevant state to share or reason about.

set -u

heading() { printf '\n\033[1;35m── %s\033[0m\n' "$1"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()    { printf '  \033[33m!\033[0m %s\n' "$*"; }
miss()    { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note()    { printf '    \033[2m%s\033[0m\n' "$*"; }

# ── Distro ────────────────────────────────────────────────────────────
heading "Host"
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  ok "${PRETTY_NAME:-$NAME}"
elif [[ "$(uname)" = "Darwin" ]]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"
else
  warn "Unknown distro ($(uname))"
fi
ok "kernel $(uname -r)  ·  $(uname -m)"
ok "user $(id -un)  ·  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp}"

# ── llama.cpp binaries ────────────────────────────────────────────────
heading "llama.cpp binaries"
for bin in llama-server llama-cli llama-bench; do
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin → $(command -v "$bin")"
  else
    miss "$bin not on PATH"
  fi
done

# ── pi-llm config ─────────────────────────────────────────────────────
heading "pi-llm"
if command -v pi-llm >/dev/null 2>&1; then
  ok "pi-llm → $(command -v pi-llm)"
else
  miss "pi-llm not on PATH"
fi
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/pi-llm/config.json"
if [[ -f "$CFG" ]]; then
  ok "config: $CFG"
  if command -v jq >/dev/null 2>&1; then
    jq -r 'to_entries[] | "    \(.key): \(.value)"' "$CFG"
  else
    sed 's/^/    /' "$CFG"
  fi
else
  warn "no config — run 'pi-llm setup'"
fi

# ── Server health ─────────────────────────────────────────────────────
heading "Server health"
PORT=""
if [[ -f "$CFG" ]] && command -v jq >/dev/null 2>&1; then
  PORT=$(jq -r '.defaultPort // empty' "$CFG")
fi
PORT="${PORT:-8080}"

if curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  ok "/health responding on port ${PORT}"
  if command -v jq >/dev/null 2>&1; then
    MODEL=$(curl -s -m 2 "http://127.0.0.1:${PORT}/v1/models" | jq -r '.data[0].id // "(unknown)"')
    note "loaded model: $MODEL"
    PROPS=$(curl -s -m 2 "http://127.0.0.1:${PORT}/props")
    if [[ -n "$PROPS" ]]; then
      CTX=$(echo "$PROPS" | jq -r '.default_generation_settings.n_ctx // .default_generation_settings.params.n_ctx // empty')
      SLOTS=$(echo "$PROPS" | jq -r '.total_slots // empty')
      note "ctx: ${CTX:-?}  ·  slots: ${SLOTS:-?}"
    fi
  fi
else
  warn "no llama.cpp /health response on port ${PORT}"
  if command -v ss >/dev/null 2>&1; then
    BOUND=$(ss -tln 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p {print $4; exit}')
    if [[ -n "$BOUND" ]]; then
      warn "port ${PORT} IS bound to $BOUND, but it isn't a llama.cpp server"
      TITLE=$(curl -s -m 2 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -oiE '<title>[^<]+</title>' | head -1)
      [[ -n "$TITLE" ]] && note "page title: ${TITLE}"
    else
      note "port ${PORT} is free — start a server with 'pi-llm serve'"
    fi
  fi
fi

# ── PID file ──────────────────────────────────────────────────────────
heading "Managed-server PID"
PIDFILE="${XDG_RUNTIME_DIR:-/tmp}/pi-llm-server.pid"
if [[ -f "$PIDFILE" ]]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    ok "PIDFILE → $PID (alive)"
  else
    warn "PIDFILE → $PID (stale; process gone)"
    note "pi-llm cleans this up on next run"
  fi
else
  note "no PIDFILE at $PIDFILE  (server isn't pi-llm-managed)"
fi

# ── Models dir ────────────────────────────────────────────────────────
heading "Models"
MODELS_DIR=""
if [[ -f "$CFG" ]] && command -v jq >/dev/null 2>&1; then
  MODELS_DIR=$(jq -r '.modelsDir // empty' "$CFG")
fi
MODELS_DIR="${MODELS_DIR:-$HOME/.lmstudio/models}"
if [[ -d "$MODELS_DIR" ]]; then
  COUNT=$(find -L "$MODELS_DIR" -name '*.gguf' \! -name 'mmproj*' \! -name 'ggml-vocab-*' 2>/dev/null | wc -l)
  SIZE=$(du -sh "$MODELS_DIR" 2>/dev/null | awk '{print $1}')
  ok "$MODELS_DIR  ($COUNT models, $SIZE on disk)"
else
  miss "$MODELS_DIR does not exist"
fi

# ── pi (coding agent) ─────────────────────────────────────────────────
heading "pi coding agent"
if command -v pi >/dev/null 2>&1; then
  ok "pi → $(command -v pi)  ($(pi --version 2>/dev/null | head -1))"
  PI_MODELS="$HOME/.pi/agent/models.json"
  if [[ -f "$PI_MODELS" ]]; then
    if command -v jq >/dev/null 2>&1; then
      PROVIDERS=$(jq -r '.providers | keys[]' "$PI_MODELS" 2>/dev/null | paste -sd, -)
      ok "$PI_MODELS  (providers: ${PROVIDERS:-none})"
    else
      ok "$PI_MODELS exists"
    fi
  else
    note "$PI_MODELS not yet written (pi-llm writes it before launching pi)"
  fi
else
  warn "pi not on PATH — only the 'pi' subcommand of pi-llm needs it"
fi

# ── GPU / Vulkan ──────────────────────────────────────────────────────
heading "GPU"
if command -v vulkaninfo >/dev/null 2>&1; then
  GPUS=$(vulkaninfo --summary 2>/dev/null | grep -E 'deviceName' | head -3 | sed 's/^[[:space:]]*deviceName[[:space:]]*=[[:space:]]*//')
  if [[ -n "$GPUS" ]]; then
    while IFS= read -r line; do ok "Vulkan: $line"; done <<<"$GPUS"
  else
    warn "vulkaninfo found no GPUs"
  fi
elif [[ "$(uname)" = "Darwin" ]]; then
  ok "Metal (macOS — assumed available)"
else
  warn "vulkaninfo not installed — install vulkan-tools to inspect"
fi

if [[ -e /dev/dri ]]; then
  RENDER=$(ls /dev/dri/renderD* 2>/dev/null | tr '\n' ' ')
  [[ -n "$RENDER" ]] && note "render nodes: $RENDER"
fi

echo
