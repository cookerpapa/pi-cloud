#!/bin/sh
# Host-only Debian package-manager patch. Retained Cube/Guest artifacts have
# their own immutable provenance and are not silently rebuilt by this helper.
set -eu
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources
fi
# Disable APT's vulnerable retry path until the fixed client is installed.
apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=30 update
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=0 -o Acquire::https::Timeout=30 \
  install --yes --no-install-recommends apt=2.6.2 libapt-pkg6.0=2.6.2
rm -rf /var/lib/apt/lists/*
