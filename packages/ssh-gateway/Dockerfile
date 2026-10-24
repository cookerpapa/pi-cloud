FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS os-base
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

FROM os-base AS dependencies
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ssh-gateway/package.json packages/ssh-gateway/package.json
COPY packages/ssh-gateway/tsconfig.json packages/ssh-gateway/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts && npm cache clean --force

FROM os-base

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud SSH gateway" \
      org.opencontainers.image.description="One-time authenticated SSH bridge to exclusive Cube PTYs" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ssh-gateway/package.json packages/ssh-gateway/package.json
COPY packages/ssh-gateway/tsconfig.json packages/ssh-gateway/tsconfig.json
COPY packages/ssh-gateway/src packages/ssh-gateway/src
COPY packages/database/package.json packages/database/package.json
COPY packages/database/src packages/database/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/ssh-gateway/tsconfig.json"]
CMD ["/app/packages/ssh-gateway/src/main.ts"]
