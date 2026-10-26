FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 APPIUM_HOME=/opt/appium
ENV PATH=/opt/android-sdk/platform-tools:/opt/appium/node_modules/.bin:$PATH
RUN mkdir -p /opt/android-sdk/build-tools/37.0.0 \
 && curl --fail --location --retry 3 https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip -o /tmp/platform.zip \
 && echo '477254aa5f903c15cf51001717bdf347fb6b53e0  /tmp/platform.zip' | sha1sum -c - \
 && unzip -q /tmp/platform.zip -d /opt/android-sdk \
 && curl --fail --location --retry 3 https://dl.google.com/android/repository/build-tools_r37_linux.zip -o /tmp/build.zip \
 && echo '70954e99f4c3d9d46ee70fa32624672fe7cd6ebe  /tmp/build.zip' | sha1sum -c - \
 && unzip -q /tmp/build.zip -d /tmp/android-build \
 && cp -a /tmp/android-build/*/. /opt/android-sdk/build-tools/37.0.0/ \
 && rm -rf /tmp/android-build /tmp/platform.zip /tmp/build.zip
WORKDIR /opt/appium
COPY deploy/android/automation/package.json deploy/android/automation/package-lock.json deploy/android/automation/upstream-driver.json deploy/android/automation/prepare-driver.mjs ./
COPY deploy/android/automation/driver/package.json driver/package.json
RUN node prepare-driver.mjs && npm ci --omit=dev --ignore-scripts && appium driver list --installed --json && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
EXPOSE 4723
CMD ["appium","--address","0.0.0.0","--port","4723","--log-level","warn","--allow-insecure=uiautomator2:adb_shell"]

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Android automation" org.opencontainers.image.version="${PI_CLOUD_VERSION}" org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
