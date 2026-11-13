# The official N-API package stays in this node image, never the Worker image.
ARG PI_CLOUD_CONTROL_IMAGE
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS native-dependencies

WORKDIR /app
COPY packages/boxlite-node/native/package.json packages/boxlite-node/native/package-lock.json ./
COPY scripts/retry-npm-command.sh /tmp/retry-npm-command.sh
RUN sh /tmp/retry-npm-command.sh ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${PI_CLOUD_CONTROL_IMAGE}
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends supervisor=4.2.5-1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=native-dependencies /app/node_modules/@boxlite-ai /app/node_modules/@boxlite-ai
COPY packages/boxlite-node/package.json packages/boxlite-node/package.json
COPY packages/boxlite-node/tsconfig.json packages/boxlite-node/tsconfig.json
COPY packages/boxlite-node/src packages/boxlite-node/src
COPY deploy/cubesandbox/cube-volume-picloud-posix.sh /opt/pi-cloud/bin/workspace-volume-attachment
COPY deploy/boxlite/supervisord.conf /etc/pi-cloud/boxlite-supervisord.conf
RUN chmod 0755 /opt/pi-cloud/bin/workspace-volume-attachment \
    && node --input-type=module -e "import {JsBoxlite} from '@boxlite-ai/boxlite'; import {readFileSync} from 'node:fs'; const actual=JSON.parse(readFileSync('/app/node_modules/@boxlite-ai/boxlite/package.json')).version; const expected=JSON.parse(readFileSync('/app/packages/boxlite-node/package.json')).dependencies['@boxlite-ai/boxlite']; if(typeof JsBoxlite!=='function'||actual!==expected) process.exit(1)"
ENTRYPOINT ["/usr/bin/supervisord","-n","-c","/etc/pi-cloud/boxlite-supervisord.conf"]

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud BoxLite node adapter" org.opencontainers.image.version="${PI_CLOUD_VERSION}" org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
