FROM us-docker.pkg.dev/android-cuttlefish-artifacts/cuttlefish-orchestration/cuttlefish-orchestration@sha256:080b718302407033c99ce2653b67d33f923d1f90ae4bbed8c0846c7f89449966
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends tini iptables && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini","--","/bin/bash","/config/start.sh"]

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Android KVM runtime" org.opencontainers.image.version="${PI_CLOUD_VERSION}" org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
