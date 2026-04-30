# Installing llama.cpp — per-distro reference

This is the deep-dive reference; the SKILL.md covers the common path. Read this when you hit a build error not on the quick-fix table, or when you need to install on a distro you haven't seen before.

## The Vulkan default — why and when not

llama.cpp's `-DGGML_VULKAN=ON` is the most universal GPU backend on Linux. It works on:
- AMD GPUs (integrated Radeon iGPUs and discrete RDNA cards) via the mesa Vulkan driver
- Intel GPUs (Arc, Iris Xe, UHD) via mesa
- NVIDIA GPUs via the proprietary driver

Switch backends only when there's a specific reason:
- `-DGGML_METAL=ON` — macOS (Apple Silicon and Intel Macs with discrete GPU). Default on macOS source builds.
- `-DGGML_CUDA=ON` — NVIDIA only, with CUDA toolkit installed. ~10-30% faster than Vulkan on the same NVIDIA card. Larger build.
- `-DGGML_HIP=ON` — AMD discrete GPUs with ROCm installed. Works on RDNA2+ and CDNA. Usually 10-20% faster than Vulkan on the same card *if* ROCm is set up correctly — and ROCm setup is a project unto itself.
- CPU-only — no flag needed, just `cmake -B build -S .`. Fine for testing, painful for inference >7B.

For AMD iGPUs (Ryzen integrated graphics, Strix Halo, etc.), Vulkan is almost always the right call — ROCm is technically supported on newer RDNA iGPUs but the setup pain rarely justifies the modest speedup.

## Per-distro deps

### Debian / Ubuntu (apt)

```bash
sudo apt install -y \
  cmake build-essential pkg-config \
  libvulkan-dev glslc glslang-tools spirv-headers \
  libcurl4-openssl-dev
```

**Why each package:**
- `cmake build-essential pkg-config` — compiler toolchain
- `libvulkan-dev` — Vulkan headers + loader (the API)
- `glslc` — shaderc binary that compiles ggml's GLSL kernels to SPIR-V (newer llama.cpp builds, post-2025)
- `glslang-tools` — older `glslangValidator` binary, kept for backward compat
- `spirv-headers` — `spirv/unified1/spirv.hpp` referenced by ggml-vulkan.cpp
- `libcurl4-openssl-dev` — llama.cpp links curl by default for HuggingFace model loading

Ubuntu 22.04 LTS may not have `glslc` packaged. Workaround: `sudo apt install vulkan-validationlayers-dev shaderc` (the latter ships glslc), or use Ubuntu 24.04+.

### Arch / Manjaro / EndeavourOS (pacman)

The packaged version usually works:

```bash
sudo pacman -S llama.cpp
# or for AUR variants:
yay -S llama.cpp-vulkan-git    # Vulkan, tracks main
yay -S llama.cpp-hip-git       # ROCm
```

If building from source:

```bash
sudo pacman -S --needed cmake base-devel vulkan-headers vulkan-icd-loader glslang shaderc curl
```

### Fedora / RHEL / Rocky / AlmaLinux (dnf)

```bash
sudo dnf install -y \
  cmake gcc-c++ make pkgconf-pkg-config \
  vulkan-headers vulkan-loader-devel \
  glslang glslc \
  libcurl-devel
```

On older Fedora (38 and below) `glslc` may not be packaged; install from `libshaderc` or build shaderc from source.

### openSUSE (zypper)

```bash
sudo zypper install -y \
  cmake gcc-c++ make pkg-config \
  vulkan-headers vulkan-loader-devel \
  glslang shaderc \
  libcurl-devel
```

### Alpine (apk)

```bash
sudo apk add \
  cmake build-base pkgconfig \
  vulkan-headers vulkan-loader-dev \
  glslang shaderc \
  curl-dev
```

Alpine uses musl, which works fine for llama.cpp — but if the user's existing Linux apps assume glibc, they'll be in for a different kind of pain.

### macOS (Homebrew)

The packaged llama.cpp is well-maintained:

```bash
brew install llama.cpp
```

Source build (Metal-accelerated by default on Apple Silicon):

```bash
brew install cmake
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cmake -B ~/llama.cpp/build -S ~/llama.cpp -DGGML_METAL=ON
cmake --build ~/llama.cpp/build -j
echo 'export PATH="$HOME/llama.cpp/build/bin:$PATH"' >> ~/.zshrc
```

For Intel Macs with discrete GPU, OpenCL is dead in llama.cpp; Metal works on macOS 10.15+ with any Mac.

## After the build

The four binaries that pi-llm cares about:

| Binary | What it does |
|---|---|
| `llama-server` | OpenAI-compatible HTTP server (port 8080 default) |
| `llama-cli` | Interactive CLI chat (one-shot or `-cnv` mode) |
| `llama-bench` | Throughput benchmark (the one pi-llm bench uses) |
| `llama-quantize` | Convert one quant to another (rarely needed) |

If `~/llama.cpp/build/bin` isn't in PATH, set absolute paths in `~/.config/pi-llm/config.json`:

```json
{
  "llamaServer": "/home/you/llama.cpp/build/bin/llama-server",
  "llamaCli":    "/home/you/llama.cpp/build/bin/llama-cli",
  "llamaBench":  "/home/you/llama.cpp/build/bin/llama-bench"
}
```

## Updating

```bash
cd ~/llama.cpp
git pull
cmake --build build -j
```

Incremental — only changed files rebuild. Takes ~30s for a typical update vs 10+ minutes for a clean build.

If a pull breaks the build, `git log --oneline -10 build` won't help (it's the wrong dir); run cmake configure again to refresh the build cache: `cmake -B build -S .`.

## Verifying GPU acceleration

After the build, sanity-check the GPU is being used:

```bash
~/llama.cpp/build/bin/llama-bench -m <some-model.gguf> -ngl 999 2>&1 | grep -E '^(model|backend|build)'
```

The `backend` line should say `Vulkan` (or `Metal`/`CUDA`/`ROCm`) — if it says `CPU`, the GPU offload didn't work. Most common causes:

1. Backend wasn't compiled in — re-run cmake with the right `-DGGML_*=ON` flag.
2. GPU driver missing — `vulkaninfo --summary` should list at least one device.
3. Permissions — user not in `render` group on Linux: `sudo usermod -aG render $USER` then re-login.

## Common pitfalls

- **Built on one machine, copied to another.** llama.cpp uses `-march=native` by default, which embeds the CPU feature set into the binary. Moving the binary to a CPU without those features → `Illegal instruction` at startup. Solution: build on the deploy host, or set `-DGGML_NATIVE=OFF` and pick a conservative target.
- **NVIDIA + Vulkan.** Works, but the NVIDIA proprietary driver is required. The open-source Nouveau driver does *not* support Vulkan compute well enough.
- **Multiple GPUs.** `--main-gpu N` and `--tensor-split a,b,c` flags split work across devices. pi-llm doesn't expose these — power users edit `src/server.ts:buildServerArgs` or override via env.
- **Old gcc on RHEL/CentOS.** llama.cpp needs C++17 minimum; gcc 8+ on RHEL 8. If `make` fails on `<filesystem>` or similar, the toolchain is too old. Solution: enable EPEL or `scl enable gcc-toolset-12`.
