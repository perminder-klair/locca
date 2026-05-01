# locca setup-wizard sandbox

Fresh-machine simulation in Docker for testing `locca`'s first-run wizard
without touching the host. Build context is `git archive HEAD` piped into a
temp dir, so `node_modules/`, `dist/`, and `.git/` on the host are never
copied into the image. Containers run with `--rm` so all state vanishes on
exit.

## Quick start

```sh
# from anywhere — the script resolves paths relative to itself
./test/sandbox/sandbox.sh build         # builds locca-test-ubuntu (default)
./test/sandbox/sandbox.sh run           # interactive shell, walk the wizard
```

> **Why Ubuntu 24.04 is the default:** llama.cpp's prebuilt Linux binaries are
> built on Ubuntu and require glibc ≥ 2.38 / GLIBCXX_3.4.32 / CXXABI_1.3.15.
> The `node:20` Debian Bookworm base ships glibc 2.36, so the binary
> won't load there — `llama-server` fails before it can parse any flag.
> If you want to test Debian, build `llama.cpp` from source inside the
> container instead of using the prebuilt.

> **Apple Silicon hosts:** Docker Desktop's Linux VM exposes an `aarch64`
> CPU whose HWCAP doesn't match any of llama.cpp's per-microarch CPU shims
> (`libggml-cpu-armv8.0/8.2/8.6/9.2_*.so`). The wizard's `auto` install
> downloads the prebuilt successfully, but launching a model will fail with
> `make_cpu_buft_list: no CPU backend found`. **Workaround:** inside the
> container, run `build-llama` (baked into the image) — it builds llama.cpp
> from source with `GGML_NATIVE=ON`, places it on PATH, and resets the
> locca config so a `Pi`/`Serve` from the menu picks it up. Takes 3-8
> minutes once.

Inside the container:

```sh
locca                                              # walks the first-run wizard
ls -la ~/.locca/ && cat ~/.locca/config.json       # inspect what got written
rm -rf ~/.locca                                    # reset
npm uninstall -g @mariozechner/pi-coding-agent     # if testing pi auto-install repeatedly
locca                                              # walk again
exit                                               # --rm wipes the container
```

## Distro matrix

Each distro tests a different branch of `src/distro.ts` and its install
hint output. Pick one or build them all:

```sh
./test/sandbox/sandbox.sh build ubuntu    # detected as "ubuntu" (default)
./test/sandbox/sandbox.sh build debian    # detected as "debian" — prebuilt won't load (see note above)
./test/sandbox/sandbox.sh build arch      # detected as "arch"
./test/sandbox/sandbox.sh build fedora    # detected as "fedora"
./test/sandbox/sandbox.sh build alpine    # detected as "alpine" — musl, prebuilt won't load either

./test/sandbox/sandbox.sh build-all       # all five
```

Then:

```sh
./test/sandbox/sandbox.sh run debian      # interactive shell on Debian
```

For `debian` and `alpine`, the wizard's `auto` llama install will succeed
(the binary downloads + extracts), but launching a model will fail at the
loader — the prebuilt binary's libc/libstdc++ requirements aren't met.
Use them only to verify the **wizard flow + install hint rendering**, not
the runtime path. Use `ubuntu` / `arch` / `fedora` to also exercise running
a model.

## docker compose

Once images are built, `compose.yaml` exposes one service per distro:

```sh
docker compose -f test/sandbox/compose.yaml run --rm debian
docker compose -f test/sandbox/compose.yaml run --rm fedora
```

Note: compose can't replicate the git-archive build trick, so it relies on
images built by `sandbox.sh build`.

## Cleanup

```sh
./test/sandbox/sandbox.sh ls              # list locca-test-* images
./test/sandbox/sandbox.sh clean           # remove them all
```

## What gets exercised

- Wizard dispatch (`src/cli.ts:42-50`) and full wizard body (`src/setup.ts`)
- Distro detection + install-hint rendering (`src/distro.ts`)
- `auto` llama install: GitHub release download + extract + verify
  (`src/llama-install.ts`)
- `auto` pi install via `npm install -g @mariozechner/pi-coding-agent`
- Config write at mode 0600 (`src/config.ts`)
- Re-run short-circuit when `~/.locca/config.json` exists

Not exercised: actual model serving (no GPU); macOS-specific paths.

## What stays on the host

- Nothing in the working tree (build context is extracted to `mktemp -d`)
- `~/.locca`, `~/.npm-global`, system PATH binaries: untouched
- Only artifacts: Docker images named `locca-test-<distro>` (~1.8 GB each
  for Debian/Ubuntu, smaller for Alpine). Remove with `./sandbox.sh clean`.
