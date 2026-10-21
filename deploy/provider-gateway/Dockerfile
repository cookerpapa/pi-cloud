ARG CLI_PROXY_BASE_IMAGE=eceasy/cli-proxy-api@sha256:238691ac26ce55e4d1c5219d72e3ad74838f81eda26359912eeb415e2820d163

FROM golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS builder

ARG CLI_PROXY_SOURCE_REPOSITORY=https://github.com/cookerpapa/CLIProxyAPI.git
ARG CLI_PROXY_SOURCE_REVISION=48549e65b86d17648029190331807b89e7fd65f4

WORKDIR /src
RUN git -c http.version=HTTP/1.1 clone --no-checkout --filter=blob:none "${CLI_PROXY_SOURCE_REPOSITORY}" CLIProxyAPI \
    && cd CLIProxyAPI \
    && git config http.version HTTP/1.1 \
    && git checkout --detach "${CLI_PROXY_SOURCE_REVISION}" \
    && test "$(git rev-parse HEAD)" = "$(git rev-parse "${CLI_PROXY_SOURCE_REVISION}^{commit}")"

WORKDIR /src/CLIProxyAPI
ARG CLI_PROXY_MODEL_CATALOG_REVISION=690c37fdbe62dc05f609f3a3e609d07ea4d16bf1
RUN git -c http.version=HTTP/1.1 clone --no-checkout --filter=blob:none https://github.com/router-for-me/models.git /src/models \
    && git -C /src/models config http.version HTTP/1.1 \
    && git -C /src/models checkout --detach "${CLI_PROXY_MODEL_CATALOG_REVISION}" \
    && test "$(git -C /src/models rev-parse HEAD)" = "${CLI_PROXY_MODEL_CATALOG_REVISION}" \
    && cp /src/models/models.json internal/registry/models/models.json

RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' \
      go get github.com/go-git/go-git/v6@v6.0.0-alpha.5 github.com/klauspost/compress@v1.18.7 golang.org/x/crypto@v0.57.0 golang.org/x/net@v0.60.0 \
    && GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' go mod download \
    && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
      GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' \
      go build -buildvcs=false -trimpath \
        -ldflags="-s -w -X 'main.Version=pi-cloud-native-responses' -X 'main.Commit=${CLI_PROXY_SOURCE_REVISION}' -X 'main.BuildDate=2026-09-01'" \
        -o /out/CLIProxyAPI ./cmd/server

FROM ${CLI_PROXY_BASE_IMAGE}

COPY scripts/install-node-os-security-updates.sh /tmp/install-node-os-security-updates.sh
RUN sh /tmp/install-node-os-security-updates.sh && rm /tmp/install-node-os-security-updates.sh
COPY --from=builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
RUN chmod 0555 /CLIProxyAPI/CLIProxyAPI

# Release metadata must not invalidate pinned dependency/OS build layers.
ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=development
LABEL org.opencontainers.image.title="PiCloud model provider gateway" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
