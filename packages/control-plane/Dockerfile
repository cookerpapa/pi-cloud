FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS os-base
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

FROM os-base AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/prepare-json-parser.mjs scripts/prepare-json-parser.mjs
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
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && npm rebuild @confluentinc/kafka-javascript \
    && node scripts/prepare-json-parser.mjs \
    && node scripts/prepare-json-parser.mjs --check \
    && npm cache clean --force

FROM os-base

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud production control plane" \
      org.opencontainers.image.description="Authenticated REST/SSE and remote Supervisor control plane" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages /app/packages
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/control-plane/src packages/control-plane/src
COPY deploy/helm/pi-cloud-platform/files/model-catalog.json deploy/helm/pi-cloud-platform/files/model-catalog.json
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
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN node --import tsx --input-type=module --eval "await import('@pi-cloud/sandbox-control/runtime'); await import('@pi-cloud/runtime-core/session-projector')" \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/control-plane/tsconfig.json"]
CMD ["/app/packages/control-plane/src/main.ts"]
