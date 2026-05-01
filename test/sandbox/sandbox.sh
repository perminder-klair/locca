#!/usr/bin/env bash
# Build & run locca's first-run wizard inside a fresh Linux container.
# Build context is `git archive HEAD` extracted into a temp dir so
# node_modules / dist / .git on the host are never copied into the image.
#
# Usage:
#   ./sandbox.sh build [distro]     # build one image (default: debian)
#   ./sandbox.sh run   [distro]     # interactive shell in a fresh container
#   ./sandbox.sh build-all          # build all distros
#   ./sandbox.sh clean              # remove all locca-test-* images
#   ./sandbox.sh ls                 # list locca-test-* images
#
# distro ∈ {debian, ubuntu, arch, fedora, alpine}

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DISTROS=(ubuntu debian arch fedora alpine)
DEFAULT_DISTRO=ubuntu

tag()        { echo "locca-test-$1"; }
dockerfile() { echo "$HERE/Dockerfile.$1"; }

build() {
  local distro="${1:-$DEFAULT_DISTRO}"
  local df; df="$(dockerfile "$distro")"
  [[ -f "$df" ]] || { echo "no Dockerfile for '$distro' (have: ${DISTROS[*]})" >&2; exit 1; }

  local work; work="$(mktemp -d -t locca-sandbox.XXXXXX)"
  local rc=0

  # Tracked + untracked-not-ignored. Picks up uncommitted edits without
  # dragging in node_modules/ or dist/ (excluded via .gitignore).
  ( cd "$REPO" && git ls-files -co --exclude-standard -z ) \
    | tar --null -T - -cf - -C "$REPO" \
    | tar -x -C "$work"
  cp "$df" "$work/Dockerfile"

  local sha; sha="$(git -C "$REPO" rev-parse --short HEAD)"
  local dirty=""
  [[ -n "$(git -C "$REPO" status --porcelain)" ]] && dirty=" + working-tree changes"
  echo ">>> building $(tag "$distro") from ${sha}${dirty}"
  docker build -t "$(tag "$distro")" "$work" || rc=$?

  rm -rf "$work"
  return $rc
}

run() {
  local distro="${1:-$DEFAULT_DISTRO}"
  local img; img="$(tag "$distro")"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo ">>> image $img not found, building first..."
    build "$distro"
  fi
  echo ">>> running $img (fresh container — exit when done; --rm wipes state)"
  docker run --rm -it "$img"
}

build_all() {
  for d in "${DISTROS[@]}"; do build "$d"; done
}

clean() {
  local imgs
  imgs="$(docker images --format '{{.Repository}}' | grep '^locca-test-' || true)"
  if [[ -z "$imgs" ]]; then echo "no locca-test-* images to remove"; return; fi
  echo "$imgs" | xargs -n1 docker rmi
}

ls_images() {
  docker images --filter 'reference=locca-test-*'
}

cmd="${1:-}"; shift || true
case "$cmd" in
  build)     build "${1:-$DEFAULT_DISTRO}" ;;
  run)       run "${1:-$DEFAULT_DISTRO}" ;;
  build-all) build_all ;;
  clean)     clean ;;
  ls)        ls_images ;;
  ""|help|-h|--help)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's|^# \?||'
    ;;
  *) echo "unknown command: $cmd" >&2; exit 1 ;;
esac
