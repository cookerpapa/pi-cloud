FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ssh-gateway/package.json packages/ssh-gateway/package.json
COPY packages/ssh-gateway/tsconfig.json packages/ssh-gateway/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

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
