# syntax=docker/dockerfile:1

# =============================================================================
# aos-mcp — containerized AOS × ARTEMIS MCP service
# Stage 1 builds the TypeScript service; stage 2 is the runtime image with
# Node + Python 3.12 (artemis venv) + Android toolchain (adb/ffmpeg/scrcpy).
# =============================================================================

########## Stage 1: build the aos-mcp service ##########
FROM node:22-slim AS aos-build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

########## Stage 2: runtime ##########
FROM python:3.12-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1

# Android toolchain + media/cv system libraries.
# NOTE: package names track Debian trixie (python:3.12-slim base):
#   - android-tools-adb was renamed to `adb`
#   - libglib2.0-0 was renamed to `libglib2.0-0t64`
#   - scrcpy was dropped from the distro: installed best-effort below
#     (artemis runs without it; only screen recording is degraded).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      adb \
      ffmpeg \
      curl \
      ca-certificates \
      git \
      libgl1 \
      libglib2.0-0t64 \
      libsm6 \
      libxext6 \
      libxrender1 \
      libusb-1.0-0 \
      libgomp1; \
    if apt-get install -y --no-install-recommends scrcpy; then \
      echo "scrcpy installed"; \
    else \
      echo "NOTE: scrcpy unavailable in this distro — artemis video recording will be degraded"; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Node.js runtime (copied from the official image; no second package manager).
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# uv (python package manager used by artemis).
RUN pip install --no-cache-dir uv

WORKDIR /app

# ---- artemis: dependency layer (cached unless lockfile changes) ----
COPY artemis/pyproject.toml artemis/uv.lock /app/artemis/
COPY artemis/packages/artemis-client /app/artemis/packages/artemis-client
RUN cd /app/artemis \
 && uv sync --frozen --no-install-project

# ---- artemis: source ----
COPY artemis /app/artemis
RUN cd /app/artemis \
 && uv sync --frozen --no-install-project \
 && .venv/bin/python -c "import artemis, mcp_server; print('artemis import ok')"

# ---- aos-mcp service (runtime deps only) ----
COPY package.json package-lock.json /app/
RUN cd /app && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=aos-build /build/dist /app/dist

# Project workspace mount point + service defaults.
ENV AOS_ARTEMIS_REPO=/app/artemis \
    AOS_WORKSPACE_ROOT=/workspace
VOLUME ["/workspace"]
EXPOSE 3055

# Container idles by default so MCP clients can `docker exec` per project:
#   docker exec -i -w /workspace/<project> aos-mcp node /app/dist/index.js
# For one-shot stdio use: docker run --rm -i ... node /app/dist/index.js
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
