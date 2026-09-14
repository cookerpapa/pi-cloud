#!/bin/sh
# Build-time patch for the pinned Node bookworm image; not a container startup task.
# Debian DLA-4772-1 fixes CVE-2026-86145 and CVE-2026-89161.
set -eu

apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=3 -o Acquire::http::Timeout=30 \
  install --yes --no-install-recommends libpcre2-8-0=10.42-1+deb12u1
rm -rf /var/lib/apt/lists/*
