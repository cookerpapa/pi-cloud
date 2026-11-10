#!/usr/bin/env bash
# Copyright (c) 2026 PiCloud contributors.
# SPDX-License-Identifier: Apache-2.0
#
# CubeSandbox native binary Volume Plugin for an already-mounted POSIX shared
# filesystem. Production operators mount the same filesystem at
# /data/cube-shared/volume on every Cube node and on the trusted Volume Gateway.
# The local profile uses a single host directory at that path.

set -euo pipefail

readonly DEFAULT_BASE_DIR="/data/cube-shared/volume"
readonly VOLUME_ID_PATTERN='^pcw-[0-9a-f]{48}$'
readonly VOLUME_WORKSPACE_DIRECTORY="workspace"

operation=""
volume_id=""
name=""
sandbox_id=""
namespace=""
ref_count=""
volume_base_dir="$DEFAULT_BASE_DIR"
private_data=""
metadata=""

fail() {
  printf '%s\n' '{"error":"picloud POSIX volume operation failed"}'
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --op)
      (($# >= 2)) || fail
      operation="$2"
      shift 2
      ;;
    --volume-id)
      (($# >= 2)) || fail
      volume_id="$2"
      shift 2
      ;;
    --name)
      (($# >= 2)) || fail
      name="$2"
      shift 2
      ;;
    --sandbox-id)
      (($# >= 2)) || fail
      sandbox_id="$2"
      shift 2
      ;;
    --namespace)
      (($# >= 2)) || fail
      namespace="$2"
      shift 2
      ;;
    --ref-count)
      (($# >= 2)) || fail
      ref_count="$2"
      shift 2
      ;;
    --volume-base-dir)
      (($# >= 2)) || fail
      volume_base_dir="$2"
      shift 2
      ;;
    --private-data)
      (($# >= 2)) || fail
      private_data="$2"
      shift 2
      ;;
    --metadata)
      (($# >= 2)) || fail
      metadata="$2"
      shift 2
      ;;
    *)
      fail
      ;;
  esac
done

[[ "$volume_id" =~ $VOLUME_ID_PATTERN ]] || fail
[[ "$volume_base_dir" == "$DEFAULT_BASE_DIR" ]] || fail
readonly volume_path="${DEFAULT_BASE_DIR}/picloud-posix-${volume_id}"
readonly workspace_path="${volume_path}/${VOLUME_WORKSPACE_DIRECTORY}"
readonly metadata_path="${volume_path}/.pi-cloud-runtime"
readonly identity_path="${metadata_path}/identity"
readonly marker_path="${metadata_path}/delete-authorized"

read_identity() {
  [[ -d "$metadata_path" && ! -L "$metadata_path" ]] || fail
  [[ -f "$identity_path" && ! -L "$identity_path" ]] || fail
  [[ "$(stat -c %s -- "$identity_path")" -le 256 ]] || fail
  mapfile -t identity_fields < "$identity_path"
  [[ "${#identity_fields[@]}" -eq 3 ]] || fail
  [[ "${identity_fields[0]}" == "pi-cloud-volume-v1" && "${identity_fields[1]}" == "$volume_id" ]] || fail
  volume_generation="${identity_fields[2]}"
  [[ "$volume_generation" =~ ^[0-9a-f]{64}$ ]] || fail
}

assert_safe_root() {
  [[ -d "$DEFAULT_BASE_DIR" && ! -L "$DEFAULT_BASE_DIR" ]] || fail
}

assert_safe_volume() {
  [[ -d "$volume_path" && ! -L "$volume_path" ]] || fail
  local resolved_root resolved_volume
  resolved_root="$(realpath "$DEFAULT_BASE_DIR")"
  resolved_volume="$(realpath "$volume_path")"
  [[ "$resolved_volume" == "${resolved_root}/picloud-posix-${volume_id}" ]] || fail
}

assert_safe_workspace() {
  [[ -d "$workspace_path" && ! -L "$workspace_path" ]] || fail
  local resolved_volume resolved_workspace
  resolved_volume="$(realpath "$volume_path")"
  resolved_workspace="$(realpath "$workspace_path")"
  [[ "$resolved_workspace" == "${resolved_volume}/${VOLUME_WORKSPACE_DIRECTORY}" ]] || fail
}

# Share admission with the Volume Gateway. The lock file is never replaced while
# the envelope exists; plugin holds never enter the Guest's Workspace mount.
lock_volume() {
  [[ ! -L "${metadata_path}/gateway.lock" ]] || fail
  exec {volume_lock}<> "${metadata_path}/gateway.lock"
  [[ -f "${metadata_path}/gateway.lock" ]] || fail
  chmod 0600 -- "${metadata_path}/gateway.lock"
  chown 1000:1000 -- "${metadata_path}/gateway.lock"
  flock -x "$volume_lock"
  read_identity
  [[ -d "${metadata_path}/attachments" && ! -L "${metadata_path}/attachments" ]] || fail
}

read_holder() {
  [[ -f "$holder_path" && ! -L "$holder_path" ]] || fail
  [[ "$(stat -c %s -- "$holder_path")" -le 1024 ]] || fail
  mapfile -t holder_fields < "$holder_path"
  [[ "${#holder_fields[@]}" -eq 4 ]] || fail
  [[ "${holder_fields[0]}" == "$volume_generation" && "${holder_fields[1]}" == "$namespace" && "${holder_fields[2]}" == "$sandbox_id" ]] || fail
  hold="${holder_fields[3]}"
  [[ "$hold" =~ ^[0-9a-f]{64}$ ]] || fail
}

case "$operation" in
  create)
    [[ -z "$name" || "$name" == "$volume_id" ]] || fail
    assert_safe_root
    if [[ -e "$volume_path" && ! -d "$volume_path" ]] || [[ -L "$volume_path" ]]; then
      fail
    fi
    mkdir -p -- "$volume_path"
    assert_safe_volume
    chmod 0700 -- "$volume_path"
    chown 1000:1000 -- "$volume_path"
    [[ ! -L "$metadata_path" ]] || fail
    mkdir -p -- "$metadata_path"
    chmod 0700 -- "$metadata_path"
    chown 1000:1000 -- "$metadata_path"
    # The lock is on the directory, not a second identity file. A crashed
    # initializer releases it; no Agent file operation takes this lock.
    exec {initialization_lock}< "$metadata_path"
    flock -x "$initialization_lock"
    [[ ! -e "$marker_path" && ! -L "$marker_path" ]] || fail
    # Private staging files cannot be mounted into a Guest. Only the holder
    # cleans leftovers; publication still refuses replacement if a lock is lost.
    find "$metadata_path" -maxdepth 1 -type f -name '.identity.????????' -delete
    if [[ -e "$identity_path" || -L "$identity_path" ]]; then
      read_identity
      assert_safe_workspace
      [[ -d "${metadata_path}/attachments" && ! -L "${metadata_path}/attachments" ]] || fail
      sync -- "$identity_path" "$metadata_path" "$volume_path" "$DEFAULT_BASE_DIR"
      printf '%s\n' '{"token":"","private_data":"picloud-posix-v2","error":""}'
      exit 0
    fi
    [[ -z "$(find "$metadata_path" -mindepth 1 -maxdepth 1 ! -name attachments -print -quit)" ]] || fail
    if [[ -e "${metadata_path}/attachments" || -L "${metadata_path}/attachments" ]]; then
      [[ -d "${metadata_path}/attachments" && ! -L "${metadata_path}/attachments" ]] || fail
      [[ -z "$(find "${metadata_path}/attachments" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail
    fi
    if [[ -e "$workspace_path" && ! -d "$workspace_path" ]] || [[ -L "$workspace_path" ]]; then
      fail
    fi
    mkdir -p -- "$workspace_path"
    assert_safe_workspace
    [[ -z "$(find "$workspace_path" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail
    chmod 0700 -- "$workspace_path"
    chown 1000:1000 -- "$workspace_path"
    mkdir -p -- "${metadata_path}/attachments"
    chmod 0700 -- "${metadata_path}/attachments"
    chown 1000:1000 -- "${metadata_path}/attachments"
    sync -- "${metadata_path}/attachments"
    temporary_identity="$(mktemp "${metadata_path}/.identity.XXXXXXXX")"
    trap 'rm -f -- "$temporary_identity"' EXIT
    volume_generation="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$volume_generation" =~ ^[0-9a-f]{64}$ ]] || fail
    printf 'pi-cloud-volume-v1\n%s\n%s\n' "$volume_id" "$volume_generation" > "$temporary_identity"
    chmod 0400 -- "$temporary_identity"
    chown 1000:1000 -- "$temporary_identity"
    sync -- "$temporary_identity" "$workspace_path"
    # ln never replaces an existing destination. Adopt only a complete identity
    # for this exact Volume; never copy or rename over user data.
    if ! ln -T -- "$temporary_identity" "$identity_path"; then
      read_identity
    fi
    rm -f -- "$temporary_identity"
    trap - EXIT
    sync -- "$metadata_path" "$volume_path" "$DEFAULT_BASE_DIR"
    printf '%s\n' '{"token":"","private_data":"picloud-posix-v2","error":""}'
    ;;
  destroy)
    assert_safe_root
    if [[ ! -e "$volume_path" ]]; then
      printf '%s\n' '{"error":""}'
      exit 0
    fi
    assert_safe_volume
    # Native reference counts can drift. Our supported plugin owns a separate
    # durable hold for each exposed path; a missing Detach never means zero.
    lock_volume
    [[ -z "$(find "${metadata_path}/attachments" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail
    [[ -f "$marker_path" && ! -L "$marker_path" ]] || fail
    expected_marker="$(printf 'pi-cloud-volume-delete-v1\n%s\n%s' "$volume_id" "$volume_generation")"
    [[ "$(cat -- "$marker_path")" == "$expected_marker" ]] || fail
    if [[ -e "$workspace_path" || -L "$workspace_path" ]]; then
      assert_safe_workspace
      rm -rf --one-file-system --preserve-root=all -- "$workspace_path" || fail
    fi
    printf '%s\n' '{"error":""}'
    ;;
  attach)
    [[ "$sandbox_id" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$namespace" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$ref_count" =~ ^[0-9]+$ ]] || fail
    [[ -z "$private_data" || "$private_data" == "picloud-posix-v2" ]] || fail
    assert_safe_root
    assert_safe_volume
    lock_volume
    [[ ! -e "$marker_path" && ! -L "$marker_path" ]] || fail
    assert_safe_workspace
    # The native hook has no attachment-incarnation id. Allocate an opaque
    # receipt per successful call, even for a repeated sandbox id. A lost reply
    # can retain an extra hold; it must never let an old Detach release new bytes.
    hold="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$hold" =~ ^[0-9a-f]{64}$ ]] || fail
    holder="$(printf '%s\n' "$namespace" "$sandbox_id" "$hold" | sha256sum | cut -d ' ' -f 1)"
    holder_path="${metadata_path}/attachments/${holder}"
    temporary_holder="$(mktemp "${metadata_path}/.holder.XXXXXXXX")"
    trap 'rm -f -- "$temporary_holder"' EXIT
    printf '%s\n%s\n%s\n%s\n' "$volume_generation" "$namespace" "$sandbox_id" "$hold" > "$temporary_holder"
    chmod 0400 -- "$temporary_holder"
    sync -- "$temporary_holder"
    ln -T -- "$temporary_holder" "$holder_path" || fail
    rm -- "$temporary_holder"
    trap - EXIT
    sync -- "$holder_path" "${metadata_path}/attachments" "$metadata_path"
    printf '{"host_path":"%s","metadata":{"driver":"picloud-posix-v3","holder":"%s","hold":"%s"},"error":""}\n' \
      "$workspace_path" "$holder" "$hold"
    ;;
  detach)
    [[ "$sandbox_id" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$namespace" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$ref_count" =~ ^[0-9]+$ ]] || fail
    assert_safe_root
    assert_safe_volume
    lock_volume
    # A failed Attach has no authority to release any successful attachment.
    if [[ "$metadata" == '{}' || -z "$metadata" ]]; then
      printf '%s\n' '{"error":""}'
      exit 0
    fi
    [[ "$metadata" =~ \"holder\"[[:space:]]*:[[:space:]]*\"([0-9a-f]{64})\" ]] || fail
    holder="${BASH_REMATCH[1]}"
    [[ "$metadata" =~ \"hold\"[[:space:]]*:[[:space:]]*\"([0-9a-f]{64})\" ]] || fail
    supplied_hold="${BASH_REMATCH[1]}"
    holder_path="${metadata_path}/attachments/${holder}"
    if [[ -e "$holder_path" || -L "$holder_path" ]]; then
      read_holder
      # A delayed Detach for a preceding lifetime must not release the new one.
      if [[ "$hold" == "$supplied_hold" ]]; then
        rm -- "$holder_path"
        sync -- "${metadata_path}/attachments"
      fi
    fi
    printf '%s\n' '{"error":""}'
    ;;
  *)
    fail
    ;;
esac
