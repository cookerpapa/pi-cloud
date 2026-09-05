ARG CLI_PROXY_BASE_IMAGE=eceasy/cli-proxy-api@sha256:238691ac26ce55e4d1c5219d72e3ad74838f81eda26359912eeb415e2820d163

FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS builder

ARG CLI_PROXY_SOURCE_REPOSITORY=https://github.com/cookerpapa/CLIProxyAPI.git
ARG CLI_PROXY_SOURCE_REVISION=48549e65b86d17648029190331807b89e7fd65f4

WORKDIR /src
RUN git clone --filter=blob:none "${CLI_PROXY_SOURCE_REPOSITORY}" CLIProxyAPI \
    && cd CLIProxyAPI \
    && git checkout --detach "${CLI_PROXY_SOURCE_REVISION}" \
    && test "$(git rev-parse HEAD)" = "$(git rev-parse "${CLI_PROXY_SOURCE_REVISION}^{commit}")"

WORKDIR /src/CLIProxyAPI
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
