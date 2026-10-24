FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Cube API authorizer" \
      org.opencontainers.image.description="Path-and-method-scoped auth callback for private CubeAPI management" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY packages/cube-api-authorizer/src packages/cube-api-authorizer/src
RUN install -d -o 1000 -g 1000 -m 0500 /run/pi-cloud-secrets \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/cube-api-authorizer/src/main.ts"]
