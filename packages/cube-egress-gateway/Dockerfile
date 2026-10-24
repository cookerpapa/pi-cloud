FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Cube egress gateway" \
      org.opencontainers.image.description="Hot-configured public HTTP(S) proxy boundary for CubeSandbox microVMs" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY packages/cube-egress-gateway/src packages/cube-egress-gateway/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
RUN mkdir -p /run/pi-cloud-secrets \
    && chown 1000:1000 /run/pi-cloud-secrets \
    && chmod 0750 /run/pi-cloud-secrets

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/packages/cube-egress-gateway/src/main.ts"]
