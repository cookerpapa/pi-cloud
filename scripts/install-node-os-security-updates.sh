#!/bin/sh
# Build-time patch for the pinned Node bookworm image; not a container startup task.
# Keep the security revisions explicit; release scans verify the final image.
set -eu

# Match the existing Volume Gateway build mirror. APT still verifies Debian's
# signed metadata and installs the exact security revisions below.
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
    -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
    /etc/apt/sources.list.d/debian.sources
fi

apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=3 -o Acquire::http::Timeout=30 \
  install --yes --no-install-recommends \
    libpcre2-8-0=10.42-1+deb12u2 \
    perl-base=5.36.0-7+deb12u4
rm -rf /var/lib/apt/lists/*
