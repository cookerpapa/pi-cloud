ARG CLI_PROXY_BASE_IMAGE=eceasy/cli-proxy-api@sha256:238691ac26ce55e4d1c5219d72e3ad74838f81eda26359912eeb415e2820d163

FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS builder

ARG CLI_PROXY_SOURCE_REPOSITORY=https://github.com/cookerpapa/CLIProxyAPI.git
ARG CLI_PROXY_SOURCE_REVISION=48549e65b86d17648029190331807b89e7fd65f4
ARG CLI_PROXY_MODEL_CATALOG_REVISION=4d4647e8ca669f23c27c76a7d0bc32fe98d0a909

WORKDIR /src
RUN git -c http.version=HTTP/1.1 clone --no-checkout --filter=blob:none "${CLI_PROXY_SOURCE_REPOSITORY}" CLIProxyAPI \
    && cd CLIProxyAPI \
    && git config http.version HTTP/1.1 \
    && git checkout --detach "${CLI_PROXY_SOURCE_REVISION}" \
    && test "$(git rev-parse HEAD)" = "$(git rev-parse "${CLI_PROXY_SOURCE_REVISION}^{commit}")"

WORKDIR /src/CLIProxyAPI
RUN git -c http.version=HTTP/1.1 clone --no-checkout --filter=blob:none https://github.com/router-for-me/models.git /src/models \
    && git -C /src/models config http.version HTTP/1.1 \
    && git -C /src/models checkout --detach "${CLI_PROXY_MODEL_CATALOG_REVISION}" \
    && test "$(git -C /src/models rev-parse HEAD)" = "${CLI_PROXY_MODEL_CATALOG_REVISION}" \
    && cp /src/models/models.json internal/registry/models/models.json

RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' go mod download \
    && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
      GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' \
      go build -buildvcs=false -trimpath \
        -ldflags="-s -w -X 'main.Version=pi-cloud-native-responses' -X 'main.Commit=${CLI_PROXY_SOURCE_REVISION}' -X 'main.BuildDate=2026-09-01'" \
        -o /out/CLIProxyAPI ./cmd/server

FROM ${CLI_PROXY_BASE_IMAGE}

COPY --from=builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
RUN chmod 0555 /CLIProxyAPI/CLIProxyAPI
