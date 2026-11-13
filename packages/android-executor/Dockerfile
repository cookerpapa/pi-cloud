# The matched Control Plane image supplies pinned protocol/HTTPS completion libraries.
ARG PI_CLOUD_CONTROL_IMAGE
FROM ${PI_CLOUD_CONTROL_IMAGE}
COPY packages/executor-runtime packages/executor-runtime
USER root
RUN ln -sfn ../../packages/executor-runtime /app/node_modules/@pi-cloud/executor-runtime
USER 1000:1000
COPY packages/android-executor/package.json packages/android-executor/package.json
COPY packages/android-executor/tsconfig.json packages/android-executor/tsconfig.json
COPY packages/android-executor/src packages/android-executor/src
ENTRYPOINT ["node","/app/node_modules/tsx/dist/cli.mjs","--tsconfig","/app/packages/android-executor/tsconfig.json"]
CMD ["/app/packages/android-executor/src/main.ts"]

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Android executor" org.opencontainers.image.version="${PI_CLOUD_VERSION}" org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
