#!/bin/sh
# Host-only Debian package-manager patch. Retained Cube/Guest artifacts have
# their own immutable provenance and are not silently rebuilt by this helper.
set -eu
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
    -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
    /etc/apt/sources.list.d/debian.sources
fi
# The slim base has no CA bundle. Bootstrap from signed Debian archives with
# retries disabled; do not disable signature or TLS certificate verification.
apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 update
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=0 -o Acquire::http::Timeout=30 \
  install --yes --no-install-recommends apt=2.6.2 libapt-pkg6.0=2.6.2
rm -rf /var/lib/apt/lists/*
