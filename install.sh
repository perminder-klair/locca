#!/bin/bash
# pi-llm interactive installer
# Bootstraps deps, asks for paths/defaults, writes config, installs the binary.
# Works on Arch (pacman), Debian/Ubuntu (apt), Fedora/RHEL (dnf), openSUSE
# (zypper), and Alpine (apk). Falls back to binary downloads where needed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-llm"
CONFIG_FILE="$CONFIG_DIR/config"

have() { command -v "$1" >/dev/null 2>&1; }

# ── 0. Package-manager detection ───────────────────────────────────────
PKG_MGR=unknown
detect_pkg_mgr() {
    if   have pacman;  then PKG_MGR=pacman
    elif have apt-get; then PKG_MGR=apt
    elif have dnf;     then PKG_MGR=dnf
    elif have zypper;  then PKG_MGR=zypper
    elif have apk;     then PKG_MGR=apk
    fi
}
detect_pkg_mgr

# Map a generic command name to the right package name for the active distro.
# Most names are identical across distros; this only handles the exceptions.
pkg_for() {
    local cmd="$1"
    case "$PKG_MGR:$cmd" in
        pacman:python3) echo python ;;
        dnf:python3)    echo python3 ;;
        zypper:python3) echo python3 ;;
        apt:python3)    echo python3 ;;
        apk:python3)    echo python3 ;;
        *)              echo "$cmd" ;;
    esac
}

pkg_install() {
    # Translate generic command names → packages, then run the installer.
    local -a pkgs=()
    local cmd
    for cmd in "$@"; do pkgs+=("$(pkg_for "$cmd")"); done
    case "$PKG_MGR" in
        pacman) sudo pacman -S --needed "${pkgs[@]}" ;;
        apt)    sudo apt-get update && sudo apt-get install -y "${pkgs[@]}" ;;
        dnf)    sudo dnf install -y "${pkgs[@]}" ;;
        zypper) sudo zypper install -y "${pkgs[@]}" ;;
        apk)    sudo apk add "${pkgs[@]}" ;;
        *) return 1 ;;
    esac
}

# ── 1. Bootstrap gum (the rest of the installer uses gum) ──────────────
install_gum_binary() {
    # Universal fallback: download a release tarball from GitHub into
    # ~/.local/bin. Works on any Linux with curl + tar.
    have curl || { echo "curl is required to bootstrap gum. Install curl first."; exit 1; }
    have tar  || { echo "tar is required to bootstrap gum. Install tar first.";  exit 1; }

    local arch
    case "$(uname -m)" in
        x86_64|amd64)  arch=x86_64 ;;
        aarch64|arm64) arch=arm64 ;;
        armv7l|armv7)  arch=armv7 ;;
        i386|i686)     arch=i386 ;;
        *) echo "Unsupported arch $(uname -m). Install gum manually: https://github.com/charmbracelet/gum"; exit 1 ;;
    esac

    echo "Downloading latest gum release for Linux/${arch}..."
    local tag
    tag=$(curl -fsSL https://api.github.com/repos/charmbracelet/gum/releases/latest \
          | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
          | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [[ -z "$tag" ]] && { echo "Could not determine latest gum release."; exit 1; }
    local ver="${tag#v}"
    local url="https://github.com/charmbracelet/gum/releases/download/${tag}/gum_${ver}_Linux_${arch}.tar.gz"

    local tmp
    tmp=$(mktemp -d)
    curl -fsSL "$url" -o "$tmp/gum.tar.gz" || { echo "Download failed: $url"; rm -rf "$tmp"; exit 1; }
    tar -xzf "$tmp/gum.tar.gz" -C "$tmp"

    local bin
    bin=$(find "$tmp" -type f -name gum -perm -u+x | head -1)
    [[ -z "$bin" ]] && { echo "gum binary not found in archive."; rm -rf "$tmp"; exit 1; }

    mkdir -p "$HOME/.local/bin"
    install -m 0755 "$bin" "$HOME/.local/bin/gum"
    rm -rf "$tmp"

    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) echo "Note: $HOME/.local/bin is not in \$PATH — adding it for this session."
           echo "      Add it to your shell rc to make gum permanently available."
           export PATH="$HOME/.local/bin:$PATH" ;;
    esac
    echo "Installed gum to $HOME/.local/bin/gum"
}

ensure_gum() {
    have gum && return 0
    echo "pi-llm installer needs 'gum' for the interactive UI."

    # Distros that ship gum in their default repos: Arch, Alpine, Fedora 38+.
    # Try the package manager first, then fall back to a binary download.
    local tried_pkg=0
    case "$PKG_MGR" in
        pacman)
            read -rp "Install gum via pacman? [Y/n] " ans
            if [[ ! "$ans" =~ ^[Nn] ]]; then
                tried_pkg=1
                sudo pacman -S --needed gum && return 0 || true
            fi
            ;;
        apk)
            read -rp "Install gum via apk? [Y/n] " ans
            if [[ ! "$ans" =~ ^[Nn] ]]; then
                tried_pkg=1
                sudo apk add gum && return 0 || true
            fi
            ;;
        dnf)
            read -rp "Try installing gum via dnf? (Fedora 38+ has it) [Y/n] " ans
            if [[ ! "$ans" =~ ^[Nn] ]]; then
                tried_pkg=1
                sudo dnf install -y gum 2>/dev/null && return 0 || \
                    echo "gum not available via dnf — falling back to binary download."
            fi
            ;;
    esac

    [[ $tried_pkg -eq 0 ]] && \
        echo "No packaged gum on this distro — will download the binary release from GitHub."
    read -rp "Download gum binary into ~/.local/bin? [Y/n] " ans
    if [[ "$ans" =~ ^[Nn] ]]; then
        echo "Aborting — install gum manually then re-run: https://github.com/charmbracelet/gum"
        exit 1
    fi
    install_gum_binary
}

ensure_gum

banner() {
    gum style \
        --foreground 212 --bold \
        --border rounded --border-foreground 240 \
        --padding "1 3" --margin "1 0" \
        "pi-llm installer" "" "Local LLM inference manager for llama.cpp"
}

note()  { gum style --foreground 240 "  $*"; }
ok()    { gum style --foreground 78  "✓ $*"; }
warn()  { gum style --foreground 214 "! $*"; }
err()   { gum style --foreground 196 "✗ $*"; }

# ── 2. Dependency check ────────────────────────────────────────────────
# Required deps for the TUI itself.
check_deps() {
    gum style --foreground 212 --bold "Checking core dependencies"
    local -a missing=()
    local cmd
    for cmd in bash curl jq python3; do
        if have "$cmd"; then
            ok "$cmd"
        else
            missing+=("$cmd")
        fi
    done

    [[ ${#missing[@]} -eq 0 ]] && return 0

    warn "Missing: ${missing[*]}"
    if [[ "$PKG_MGR" == unknown ]]; then
        err "No supported package manager detected. Install ${missing[*]} manually then re-run."
        exit 1
    fi
    if gum confirm "Install via $PKG_MGR: ${missing[*]}?"; then
        pkg_install "${missing[@]}"
    else
        err "Aborting — required dependencies missing."
        exit 1
    fi
}

# llama.cpp can come from a distro package (Arch only, currently), AUR
# variants, or a source build. We only check that the binaries exist.
llamacpp_install_hint() {
    case "$PKG_MGR" in
        pacman)
            note "  sudo pacman -S llama.cpp                # official Arch package"
            note "  yay -S llama.cpp-vulkan-git             # AUR (Vulkan / Radeon)"
            note "  yay -S llama.cpp-hip-git                # AUR (ROCm / HIP)"
            ;;
        *)
            note "  No distro package on $PKG_MGR — build from source."
            ;;
    esac
    note "  Source: https://github.com/ggml-org/llama.cpp"
    note ""
    note "  Quick build (Vulkan, AMD/Intel iGPU + most NVIDIA):"
    note "    git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp"
    note "    cmake -B ~/llama.cpp/build -S ~/llama.cpp -DGGML_VULKAN=ON"
    note "    cmake --build ~/llama.cpp/build -j"
    note "    export PATH=\"\$HOME/llama.cpp/build/bin:\$PATH\""
}

check_llamacpp() {
    gum style --foreground 212 --bold "llama.cpp"
    if have llama-server && have llama-cli; then
        ok "llama-server: $(command -v llama-server)"
        ok "llama-cli:    $(command -v llama-cli)"
        return 0
    fi
    warn "llama-server / llama-cli not found in PATH."
    note "Install one of:"
    llamacpp_install_hint
    note ""
    note "If you build from source, add the build/bin dir to PATH or set"
    note "LLAMA_SERVER / LLAMA_CLI to absolute paths in $CONFIG_FILE."
    if [[ "$PKG_MGR" == pacman ]] && gum confirm --default=no "Try 'sudo pacman -S llama.cpp' now?"; then
        sudo pacman -S --needed llama.cpp || warn "pacman install failed — install manually."
    fi
}

# ── 3. Optional deps (rocm-smi, vulkan-tools) ──────────────────────────
check_optional() {
    gum style --foreground 212 --bold "Optional tools"
    have rocm-smi   && ok "rocm-smi (AMD VRAM monitoring)" || note "rocm-smi missing (optional, AMD only)"
    have vulkaninfo && ok "vulkaninfo"                     || note "vulkan-tools missing (optional)"
}

# ── 4. Models directory ────────────────────────────────────────────────
configure_models() {
    gum style --foreground 212 --bold "Models directory"
    local default="$HOME/.lmstudio/models"
    local existing=""
    [[ -f "$CONFIG_FILE" ]] && existing=$(grep -oP '^MODELS_DIR="\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "")
    local current="${existing:-$default}"

    MODELS_DIR=$(gum input \
        --header "Where do you keep .gguf models?" \
        --placeholder "$current" \
        --value "$current" \
        --width 70)
    MODELS_DIR="${MODELS_DIR:-$current}"
    # Expand leading ~
    MODELS_DIR="${MODELS_DIR/#\~/$HOME}"

    if [[ ! -d "$MODELS_DIR" ]]; then
        if gum confirm "Directory does not exist. Create $MODELS_DIR ?"; then
            mkdir -p "$MODELS_DIR"
            ok "Created $MODELS_DIR"
        else
            warn "Skipped — pi-llm will fail until this directory exists."
        fi
    fi

    local count=0
    if [[ -d "$MODELS_DIR" ]]; then
        count=$(find -L "$MODELS_DIR" -name "*.gguf" ! -name "mmproj*" 2>/dev/null | wc -l)
    fi
    ok "Models dir: $MODELS_DIR  ($count GGUF model$([[ $count -eq 1 ]] || echo s) found)"
}

# ── 5. Server defaults ─────────────────────────────────────────────────
configure_server() {
    gum style --foreground 212 --bold "Server defaults"
    # Auto-detect: leave 2 cores headroom, floor at 1.
    local nproc_total nproc_default
    nproc_total=$(nproc 2>/dev/null || echo 4)
    nproc_default=$(( nproc_total > 2 ? nproc_total - 2 : 1 ))

    if gum confirm --default=yes "Use sensible defaults? (port 8080, ctx 32768, threads $nproc_default of $nproc_total cores)"; then
        DEFAULT_PORT=8080
        DEFAULT_CTX=32768
        DEFAULT_THREADS=$nproc_default
    else
        DEFAULT_PORT=$(gum input --header "Port"          --value "8080"           --width 20)
        DEFAULT_CTX=$(gum input  --header "Context size"  --value "32768"          --width 20)
        DEFAULT_THREADS=$(gum input --header "CPU threads (system has $nproc_total)" --value "$nproc_default" --width 30)
        DEFAULT_PORT="${DEFAULT_PORT:-8080}"
        DEFAULT_CTX="${DEFAULT_CTX:-32768}"
        DEFAULT_THREADS="${DEFAULT_THREADS:-$nproc_default}"
    fi
    ok "Port $DEFAULT_PORT  |  ctx $DEFAULT_CTX  |  threads $DEFAULT_THREADS"
}

# ── 6. Optional pi (coding agent) check ────────────────────────────────
install_node_via_pkg_mgr() {
    case "$PKG_MGR" in
        pacman) sudo pacman -S --needed nodejs-lts npm ;;
        apt)    sudo apt-get update && sudo apt-get install -y nodejs npm ;;
        dnf)    sudo dnf install -y nodejs npm ;;
        zypper) sudo zypper install -y nodejs npm ;;
        apk)    sudo apk add nodejs npm ;;
        *)      return 1 ;;
    esac
}

check_pi() {
    gum style --foreground 212 --bold "pi (coding agent)"
    if have pi; then
        ok "pi found: $(command -v pi)"
        return 0
    fi
    note "pi powers the 'pi-llm pi' coding-agent subcommand."
    note "Project: https://pi.dev  |  Source: https://github.com/badlogic/pi-mono"
    if ! gum confirm --default=yes "Install pi now?"; then
        note "Skipped. To install manually later:"
        note "  npm install -g @mariozechner/pi-coding-agent"
        return 0
    fi

    local pkg="@mariozechner/pi-coding-agent"

    # Prefer mise (isolated tool versions) → fall back to npm → fall back to hints.
    if have mise; then
        if mise use -g "npm:$pkg"; then
            ok "Installed via mise"
            return 0
        fi
        warn "mise install failed, trying npm..."
    fi

    if have npm; then
        if npm install -g "$pkg"; then
            ok "Installed via npm"
            return 0
        fi
        warn "npm install failed (may need sudo or a Node version manager)."
    else
        warn "Neither mise nor npm found."
        if [[ "$PKG_MGR" != unknown ]] && gum confirm --default=yes "Install nodejs + npm via $PKG_MGR?"; then
            if install_node_via_pkg_mgr && npm install -g "$pkg"; then
                ok "Installed pi via npm"
                return 0
            fi
            warn "Install via $PKG_MGR failed."
        fi
    fi

    note "Manual install command:"
    note "  npm install -g $pkg"
    note "On Debian/Ubuntu the system 'nodejs' may be too old — consider mise or NodeSource."
}

# ── 7. Write config file ───────────────────────────────────────────────
write_config() {
    gum style --foreground 212 --bold "Writing config"
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<EOF
# pi-llm config — written by installer on $(date -I)
# Edit by hand or re-run install.sh.

MODELS_DIR="$MODELS_DIR"
DEFAULT_PORT=$DEFAULT_PORT
DEFAULT_CTX=$DEFAULT_CTX
DEFAULT_THREADS=$DEFAULT_THREADS
LLAMA_SERVER="llama-server"
LLAMA_CLI="llama-cli"
LLAMA_BENCH="llama-bench"

# Optional: pi --skill directory (used by 'pi-llm pi'). Skipped if missing.
# PI_SKILL_DIR="$HOME/.claude/skills/agent-browser"

# If you built llama.cpp from source, set absolute paths:
# LLAMA_SERVER="$HOME/llama.cpp/build/bin/llama-server"
# LLAMA_CLI="$HOME/llama.cpp/build/bin/llama-cli"
# LLAMA_BENCH="$HOME/llama.cpp/build/bin/llama-bench"
EOF
    ok "Wrote $CONFIG_FILE"
}

# ── 8. Install the binary ──────────────────────────────────────────────
install_binary() {
    gum style --foreground 212 --bold "Install pi-llm"
    local -a opts=()
    [[ "$PKG_MGR" == pacman ]] && opts+=("Build & install Arch package (makepkg -si)")
    opts+=("Symlink to ~/.local/bin/pi-llm  (no root, dev-friendly)")
    opts+=("Skip — I will install manually")

    local method
    method=$(gum choose "${opts[@]}")

    case "$method" in
        Build*)
            (cd "$REPO_DIR" && makepkg -si)
            ok "Installed via pacman."
            ;;
        Symlink*)
            mkdir -p "$HOME/.local/bin"
            ln -sf "$REPO_DIR/pi-llm" "$HOME/.local/bin/pi-llm"
            ok "Symlinked $REPO_DIR/pi-llm → $HOME/.local/bin/pi-llm"
            case ":$PATH:" in
                *":$HOME/.local/bin:"*) ;;
                *) warn "$HOME/.local/bin is not in \$PATH — add it to your shell rc." ;;
            esac
            ;;
        Skip*)
            note "Run pi-llm directly from the repo: $REPO_DIR/pi-llm"
            ;;
    esac
}

# ── main ───────────────────────────────────────────────────────────────
banner
note "Detected package manager: $PKG_MGR"
echo ""
check_deps
echo ""
check_llamacpp
echo ""
check_optional
echo ""
configure_models
echo ""
configure_server
echo ""
check_pi
echo ""
write_config
echo ""
install_binary
echo ""
gum style --foreground 78 --bold --border rounded --padding "0 2" "Done. Run: pi-llm"
