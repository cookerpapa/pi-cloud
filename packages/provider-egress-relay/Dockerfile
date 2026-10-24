FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=development
LABEL org.opencontainers.image.title="PiCloud provider egress relay" \
      org.opencontainers.image.description="Host-proxy bridge for the trusted model gateway" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY packages/provider-egress-relay/package.json packages/provider-egress-relay/package.json
COPY packages/provider-egress-relay/src packages/provider-egress-relay/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/packages/provider-egress-relay/src/main.ts"]
