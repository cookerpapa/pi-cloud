FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS os-base
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

FROM os-base AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/harden-pi-dependencies.mjs scripts/harden-pi-dependencies.mjs
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/session-attachments/package.json packages/session-attachments/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/event-log/package.json packages/event-log/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/pi-session-postgres/package.json packages/pi-session-postgres/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/sandbox-control/package.json packages/sandbox-control/package.json
COPY packages/subagent-control/package.json packages/subagent-control/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && npm rebuild @confluentinc/kafka-javascript \
    && node scripts/harden-pi-dependencies.mjs \
    && node scripts/harden-pi-dependencies.mjs --check \
    && npm cache clean --force

FROM os-base

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud trusted Supervisor host" \
      org.opencontainers.image.description="Credentialed Pi Agent Runner without Docker or user tool execution" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/control-plane/src packages/control-plane/src
COPY packages/session-attachments/package.json packages/session-attachments/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/session-attachments/src packages/session-attachments/src
COPY packages/database/src packages/database/src
COPY packages/domain/package.json packages/domain/package.json
COPY packages/domain/src packages/domain/src
COPY packages/event-log/package.json packages/event-log/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/event-log/src packages/event-log/src
COPY packages/observability/src packages/observability/src
COPY packages/pi-session-postgres/package.json packages/pi-session-postgres/package.json
COPY packages/pi-session-postgres/src packages/pi-session-postgres/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/runtime-core/src packages/runtime-core/src
COPY packages/sandbox-control/package.json packages/sandbox-control/package.json
COPY packages/sandbox-control/src packages/sandbox-control/src
COPY packages/subagent-control/package.json packages/subagent-control/package.json
COPY packages/subagent-control/src packages/subagent-control/src
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/supervisor-host/src packages/supervisor-host/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN cd /app/packages/sandbox-supervisor \
    && node --import tsx --input-type=module --eval "await import('./src/subagent-tool.ts'); await import('./src/pi-cloud-turn-runner.ts'); await import('@earendil-works/pi-durable')" \
    && cd /app/packages/sandbox-control \
    && node --input-type=module --eval "await import('undici')" \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/supervisor-host/tsconfig.json"]
CMD ["/app/packages/supervisor-host/src/main.ts"]
