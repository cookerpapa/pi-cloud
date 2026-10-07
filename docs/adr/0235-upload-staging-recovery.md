# ADR-0235: Filesystem-owned upload staging and recovery

Status: source implemented, 2026-10-07; matched rollout pending. The owner approved the
[post-release repair plan](../reports/review-repair-plan-20261007-r2.md).
This refines ADR-0234 for R07R2-01 without changing upload admission or Workspace
byte ownership. See the [repair and verification record](../reports/review-repair-20261007-r2.md).

## Decision and adoption

Reuse the installed util-linux `flock` and same-filesystem `link` primitives
behind the shared `workspace-runtime` upload module. The
[flock contract](https://man7.org/linux/man-pages/man2/flock.2.html) supplies
shared/exclusive exclusion tied to open descriptions; the
[link contract](https://man7.org/linux/man-pages/man2/link.2.html) supplies
non-overwriting publication. ADR-0231 records the pinned utility, license and
rejection of time-based lock replacement. `O_TMPFILE` would require additional
filesystem support and `linkat` bindings at every guest destination, so is not
introduced as a new deployment requirement.

## Layout and exclusion

- Ordinary Workspace uploads stage inside the plugin-owned Volume envelope at
  `.pi-cloud-runtime/uploads-v1`, outside the mounted Workspace. The Gateway
  still holds shared `gateway.lock` through upload and staging maintenance.
- Machine uploads stage in a reserved `.pi-cloud-upload-staging-v1` directory
  below the chosen working directory. It shares the destination filesystem and
  is managed by the fixed guest helper as the Tool user. It is not a new host
  security boundary; arbitrary guest filesystem access retains its normal UID.
- Each staging area has a validated format marker, stable zero-content lock
  file and a data directory. Shared staging exclusion covers creation, transfer,
  length/hash checking, fsync, publication and normal cleanup. Reaping requires
  nonblocking exclusive staging exclusion, validates directory/lock identities,
  and removes only owned temporary names. Never remove/replace a live lock file.
- Lock order is Volume admission → staging lock on the Gateway. Guest registry
  mutation and upload-area mutation never acquire their locks in reverse order;
  registration finishes before taking the upload's shared area lock. Reaping
  tries area exclusion without waiting. No shared-to-exclusive lock upgrade.
- Final placement remains an atomic no-replace hard link. Reaping a second
  temporary link cannot remove the final file. Different content at an existing
  target remains an error. A crash after publication can be resolved by the
  existing hash/length retry, without repeating an Agent or creating a new Run.

## Discovery and maintenance

Gateway startup and bounded periodic maintenance enumerate private Volume
envelopes with a continuing cursor, independently of Session upload-claim rows.
Normal upload completion also attempts nonblocking area cleanup after releasing
its shared area lock. Volume retirement removes the whole private area under
the existing Cube/reference protocol.

The guest maintains small filesystem recovery locators under
`/home/user/.pi-cloud-upload-areas-v1`: canonical area path and inode/device,
registered durably before any large staging write. The registry has its own
OS-held lock and a persistent scan cursor. It carries no uploaded bytes,
credentials, Run state or execution authority. It survives Session deletion and
working-directory changes; stale/mismatched locators cannot authorize deletion.
This refines the plan's proposed use of upload metadata: PG draft rows can expire
or cascade away and therefore cannot be the only recovery address.

The Control Plane invokes bounded guest cleanup through SandboxProvider using a
fixed `reap_upload_staging` input-helper operation for its already-owned running
development machines. Elastic Workspace staging is reclaimed at the Gateway,
without another guest RPC. It does not wake paused or inactive VMs, make health classification depend
on cleanup success, or release quotas. Maintenance is joined at shutdown and
has bounded per-VM calls and fair rotation. The guest input protocol becomes 4.
No new service, PG ledger, cleanup queue or Kafka event is added.

Missing/busy locks and filesystem/RPC errors defer reclamation. Neither PG claim
expiry nor elapsed time proves writer death. Continuous upload activity can
delay reclamation; there is no false deadline guarantee. The older guest
transport source `/tmp/pi-cloud-upload-*` remains under its existing transfer/
helper/EXIT cleanup lifetime; this collector must not infer an in-flight envd
writer's death from an unlocked pathname and sweep those transport files.

## Cutover and acceptance

Build matching Gateway/guest artifacts, drain old upload writers and keep Gateway
Recreate. Do not retain a runtime compatibility scanner for old `.upload-*`
files in user directories. Any development-data cleanup is scoped and performed
while drained. Rollback also drains writers; staging metadata contains no second
copy of committed Workspace history.

Verify killed writers with and without retry, concurrent healthy transfers,
nonblocking cleanup, fsync/link crash boundaries, conflicting/duplicate targets,
directory replacement, registry loss windows/cursor fairness, expired/deleted
PG upload rows, Volume deletion and guest maintenance failure isolation. Preserve
the guest source-transfer cancellation/trap tests. Upload grants and all native
Agent/Tool execution contracts remain unchanged.
