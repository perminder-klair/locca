# syntax=docker/dockerfile:1
#
# locca in a container — runs llama.cpp's OpenAI-compatible server head-less.
#
# Point any OpenAI-compatible client (SUB/WAVE: provider = openai-compatible)
# at http://<host>:8080/v1. See README "Running in Docker".
#
#   docker build -t locca .                       # CPU build (works anywhere)
#   docker build -t locca:vulkan \                # AMD/Intel GPU via Vulkan
#       --build-arg LLAMA_BACKEND=vulkan .
#
#   docker run --rm -p 8080:8080 \
#       -v /path/to/models:/models:ro \
#       locca qwen3.5-9b           # model name (substring match) or -e LOCCA_MODEL

# ── Stage 1: build locca from source ────────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Backend for the bundled llama.cpp:
#   cpu    — portable, runs on any host (default)
#   vulkan — AMD / Intel GPU; needs `--device /dev/dri` at run time and the
#            mesa ICD installed below
ARG LLAMA_BACKEND=cpu

# unzip       — llama.cpp release assets are .zip
# ca-certs    — TLS to GitHub for `install-llama`
# libgomp1    — OpenMP runtime the prebuilt llama-server links against
# libcurl4    — recent llama-server builds link libcurl
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates unzip libgomp1 libcurl4 \
 && if [ "$LLAMA_BACKEND" = "vulkan" ]; then \
      apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# locca itself (built in stage 1).
COPY --from=build /src /opt/locca
RUN ln -s /opt/locca/bin/locca /usr/local/bin/locca

# Download the prebuilt llama.cpp and write ~/.locca/config.json pointing at
# it. Done at build time so the image is self-contained.
RUN locca install-llama -y -b ${LLAMA_BACKEND}

# Models are bind-mounted here. LOCCA_MODELS_DIR keeps the config (which holds
# the llama-server path) separate from the mount, so neither clobbers the other.
ENV LOCCA_MODELS_DIR=/models
VOLUME ["/models"]

EXPOSE 8080

# `serve -f` is the container's main process: it streams llama-server logs to
# stdout (so `docker logs` works), stays up until killed, and propagates
# SIGTERM cleanly. Append the model name as the container command, or pass
# `-e LOCCA_MODEL=<name>`.
ENTRYPOINT ["locca", "serve", "-f"]
CMD []
