FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/device-link/package.json packages/device-link/package.json
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
RUN sh scripts/retry-npm-command.sh ci --workspace @pi-cloud/device-link --include-workspace-root=false --omit=dev --ignore-scripts
COPY packages/device-link/src packages/device-link/src
COPY packages/device-link/tsconfig.json packages/device-link/tsconfig.json
COPY tsconfig.base.json ./
ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="Pi Managed Agents device transport" org.opencontainers.image.version="${PI_CLOUD_VERSION}" org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
USER 1000:1000
EXPOSE 8090
CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "/app/packages/device-link/src/main.ts"]
