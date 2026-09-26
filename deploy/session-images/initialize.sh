#!/bin/sh
set -eu
# Private filer/volume APIs are reachable only by trusted deployment services.
# The fsync rule must be installed before applications can publish references.
result=$(printf '%s\n' \
  's3.bucket.create -name pi-cloud-session-images' \
  'fs.configure -locationPrefix=/buckets/pi-cloud-session-images/ -fsync=true -apply' \
  | weed shell -master=session-images:9333 -filer=session-images:8888 2>&1)
printf '%s\n' "$result" | grep -Eq '"fsync"[[:space:]]*:[[:space:]]*true'
