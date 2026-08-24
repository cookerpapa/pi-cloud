ARG CUBE_BASE_IMAGE=ghcr.io/tencentcloud/cubesandbox-base:2026.16@sha256:34ea312a63a5534e66ab17005c23d7fbaf33c38bccd5411ee402d901e63a3193
ARG PYTHON_BASE_IMAGE=python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1
ARG NODE_BASE_IMAGE=node:24.18.0-bullseye-slim@sha256:aca89821b1f09df223227ff2abe075fc3161f05604d3b61309f46820a5938020
FROM ${PYTHON_BASE_IMAGE} AS python-runtime
RUN python3 -m pip install --no-cache-dir --retries 5 --timeout 30 \
      "setuptools==83.0.0" \
      "wheel==0.47.0"
FROM ${NODE_BASE_IMAGE} AS node-runtime

FROM ${NODE_BASE_IMAGE} AS tool-worker-builder
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-sandbox/package.json packages/tool-sandbox/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && sh scripts/retry-npm-command.sh install --no-save --ignore-scripts esbuild@0.28.1
COPY packages/protocol/src packages/protocol/src
COPY packages/tool-sandbox/src packages/tool-sandbox/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN node node_modules/esbuild/bin/esbuild \
      packages/tool-sandbox/src/envd-tool-exec.ts \
      packages/tool-sandbox/src/envd-guest-control.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --target=node24 \
      --out-extension:.js=.mjs \
      --outdir=/out

FROM ${CUBE_BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
# Cube's base image uses the global Ubuntu archive, which is pathologically
# slow from GitHub-hosted Azure runners. This official mirror serves the same
# signed Ubuntu repository metadata and remains overrideable for self-hosters.
ARG PI_CLOUD_UBUNTU_MIRROR=http://azure.archive.ubuntu.com/ubuntu

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eu; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    sed -i \
      -e "s|http://archive.ubuntu.com/ubuntu|${PI_CLOUD_UBUNTU_MIRROR}|g" \
      -e "s|http://security.ubuntu.com/ubuntu|${PI_CLOUD_UBUNTU_MIRROR}|g" \
      /etc/apt/sources.list; \
    packages="bash ca-certificates git openjdk-17-jdk-headless util-linux"; \
    installed=0; \
    attempt=1; \
    while [ "$attempt" -le 3 ]; do \
      if apt-get \
          -o Acquire::Retries=3 \
          -o Acquire::http::Timeout=30 \
          update \
        && apt-get \
          -o Acquire::Retries=3 \
          -o Acquire::http::Timeout=30 \
          install --yes --no-install-recommends $packages; then \
        installed=1; \
        break; \
      fi; \
      dpkg --configure -a || true; \
      sleep "$((attempt * 2))"; \
      attempt="$((attempt + 1))"; \
    done; \
    test "$installed" = 1

COPY --from=python-runtime /usr/local /usr/local
COPY --from=node-runtime /usr/local /usr/local
RUN ln -sf /usr/local/bin/python3 /usr/bin/python3 \
    && ln -sf /usr/local/bin/node /usr/bin/node

RUN if ! getent group 1000 >/dev/null; then groupadd --gid 1000 pi-cloud; fi \
    && if ! getent passwd 1000 >/dev/null; then \
         useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash pi-cloud; \
       fi \
    && install -d -o 1000 -g 1000 -m 0700 \
         /workspace \
         /tmp/pi-cloud-tool-home \
    && install -d -o 0 -g 0 -m 0755 \
         /opt/pi-cloud \
         /opt/pi-cloud/bin

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-sandbox/package.json packages/tool-sandbox/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh install --global npm@12.0.2 \
    && sh scripts/retry-npm-command.sh pack --pack-destination /tmp \
         brace-expansion@5.0.9 \
         ip-address@10.4.0 \
         tar@7.5.21 \
    && rm -rf \
         /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
         /usr/local/lib/node_modules/npm/node_modules/ip-address \
         /usr/local/lib/node_modules/npm/node_modules/tar \
    && install -d /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && install -d /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && install -d /usr/local/lib/node_modules/npm/node_modules/tar \
    && tar -xzf /tmp/brace-expansion-5.0.9.tgz \
        --strip-components=1 \
        -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf /tmp/ip-address-10.4.0.tgz \
        --strip-components=1 \
        -C /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && tar -xzf /tmp/tar-7.5.21.tgz \
        --strip-components=1 \
        -C /usr/local/lib/node_modules/npm/node_modules/tar \
    && rm \
         /tmp/brace-expansion-5.0.9.tgz \
         /tmp/ip-address-10.4.0.tgz \
         /tmp/tar-7.5.21.tgz \
    && node -e 'if (require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version !== "5.0.9") process.exit(1)' \
    && node -e 'if (require("/usr/local/lib/node_modules/npm/node_modules/ip-address/package.json").version !== "10.4.0") process.exit(1)' \
    && node -e 'if (require("/usr/local/lib/node_modules/npm/node_modules/tar/package.json").version !== "7.5.21") process.exit(1)' \
    && npm cache clean --force

COPY --from=tool-worker-builder /out/envd-tool-exec.mjs /opt/pi-cloud/bin/envd-tool-exec.mjs
COPY --from=tool-worker-builder /out/envd-guest-control.mjs /opt/pi-cloud/bin/envd-guest-control.mjs
COPY --chown=1000:1000 \
  packages/sandbox-supervisor/test/fixtures/sample-java-repair \
  /opt/pi-cloud/sample-java-repair
ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=development
LABEL org.opencontainers.image.title="PiCloud CubeSandbox tool template" \
      org.opencontainers.image.description="Cube envd guest with credential-free on-demand PiCloud Tool Worker" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
RUN printf '%s\n' "${PI_CLOUD_REVISION}" > /opt/pi-cloud/image-revision \
    && chmod 0444 /opt/pi-cloud/image-revision

ENV NODE_ENV=production \
    HOME=/tmp/pi-cloud-tool-home

WORKDIR /workspace
# Reuse Cube's standard guest contract. cube-agent reaches the inherited
# entrypoint over vsock, which starts the credential-free envd data plane on
# 49983. PiCloud has no persistent guest controller; Tool Broker launches a
# uid-1000, no-new-privileges Tool Worker through envd only when work exists.
EXPOSE 49983
