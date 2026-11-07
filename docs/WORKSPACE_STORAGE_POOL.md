# Workspace storage pool operator

This operator implements the XFS deployment choice in
[ADR-0301](adr/0301-workspace-capacity-enforcement.md). It changes only the Cube
Volume directory. It does not change ext4 features, VM system disks, PostgreSQL
ownership or the release controller's draining policy.

The default backing file is sparse with a 256 GiB ceiling. That ceiling does not
reserve physical host space. The planner checks space needed to copy existing
allocated bytes and reports Workspace capacity increases needed for existing
data plus headroom. The release caller must apply those increases in PG and
reload the plan before migration. No capacity is silently reduced.

`scripts/lib/workspace-storage-pool.mjs` supplies read-only inspection, preparation,
verification and grow-only operations. Preparation accepts the complete PG
Workspace inventory and a callback which freshly confirms writer/upload
quiescence, physical absence of all VMs, and schema 212 or later. These are
external release preconditions, not facts inferred from a missing process or
heartbeat. Empty first installation may omit PG inventory and the quota helper.

In-progress uploads must settle before migration: their resumable offsets and
publication proof are tied to the old filesystem inodes. Completed/cancelled
transfer metadata can be copied with the Volume; completed Workspace files keep
their content and paths. The guard refuses an active upload instead of inventing
a resumed identity for a partially received file.

The implemented recovery procedure is:

1. Inventory every source Volume and validate its immutable identity against the
   supplied inventory. Unknown directories, nested mounts and changed identities
   stop the operation; nothing is silently omitted.
2. Journal exact paths, filesystem UUID and owned inode identities outside the
   quota projects. Acquire one kernel flock; mutation subprocesses inherit its
   file description. Publish a K3s startup dependency before any handoff, while
   withholding the mount unit until the old directory has moved out of its path.
3. Create an owned sparse image and format that image only. Stage-mount it using
   `loop,prjquota,nosuid,nodev`. Copy each Volume identity, create empty Workspace
   and upload-file roots, and apply the real quota helper before copying data.
   Both data roots must have the same project ID.
4. Copy with `rsync -aHAXS --numeric-ids`, then require an empty checksum dry run.
   The helper journal and generation markers remain on this same XFS filesystem.
   Destination reconciliation removes abandoned rsync temporaries and protects
   only the helper's fixed metadata and otherwise absent empty staging roots.
5. Stop and confirm the journal-owned transient helper service has no process;
   unmount staging, rename the original directory, create an empty canonical
   mount point, then install/start the persistent mount unit. Never mount over
   the original directory or any nonempty replacement path.
6. Verify the mounted UUID, backing-file identity, quota enforcement and remaining
   checksum comparison before deleting the recorded retired directory. Persist
   the deletion intent before removal, and confirm physical absence afterward.
   After a crash during recursive removal, the durable verification/deletion
   intent permits removing the remaining old children under the same root inode;
   changed old-directory mtimes do not cause a second copy or a false mismatch.

The mount unit is required and ordered before K3s. A startup verifier checks its
UUID and required options; a missing image, wrong filesystem or incomplete
handoff fails closed. Resume uses the existing journal and same image, never an
empty replacement. The operator stops its exact helper unit before resuming,
including after a lost systemd reply. It does not kill unrelated processes.

Growing the pool persists its target first, then uses `truncate`,
`losetup --set-capacity` and `xfs_growfs -d` on the verified mounted filesystem.
Retries finish the same growth. Shrinking, reformatting an adopted image and
automatically recreating missing state are rejected.

These choices reuse [systemd mount units](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html),
[kernel flock](https://man7.org/linux/man-pages/man1/flock.1.html),
[loop devices](https://man7.org/linux/man-pages/man8/losetup.8.html) and
[XFS growth](https://man7.org/linux/man-pages/man8/xfs_growfs.8.html).
They add a finite local maintenance journal, not another runtime authority.

The root boundary is the fixed operator CLI; the matched release need not run
as root. On the maintained WSL host it can invoke that CLI with
`wsl.exe -d Ubuntu -u root -- <absolute-node> <absolute-operator> ...`.
The CLI does not install packages, build the quota helper, drain writers or stop
native Cube services. Those remain the surrounding matched release's work.

```sh
node scripts/run-workspace-storage-pool.mjs plan --plan /absolute/private-plan.json
node scripts/run-workspace-storage-pool.mjs prepare --plan /absolute/private-plan.json
node scripts/run-workspace-storage-pool.mjs verify --runtime-directory /absolute/runtime
node scripts/run-workspace-storage-pool.mjs grow --runtime-directory /absolute/runtime --pool-bytes 549755813888
```

The plan is a mode-0600 JSON file containing `runtimeDirectory`, `domainId`,
`sourceId` (`workspace:<domainId>`), optional `poolBytes`, and `workspaces` with
`tenantId`, `workspaceId`, `volumeId`, `generation`, `revision`, `capacityBytes`.
Include every nondeleted PG Workspace in the domain; an unmaterialized Volume
uses `generation: null`. Existing Volume generations come from their immutable
identity files. Existing source directories must all match that inventory.

For existing Volumes, `quotaHelper` contains the absolute `binary`, `tokenFile`
and `meteringTokenFile` paths, the actual `meteringUrl`, and a loopback `listen`
address such as `127.0.0.1:14510`. Key contents never enter the plan, journal or
arguments. `kubeconfig` may override the maintained runtime kubeconfig path.
Use `fresh: true` only before application installation, with an empty source and
inventory; an installed Control Plane prevents this shortcut.

`prepare` rereads Kubernetes desired state and Pods, the real schema migration,
the existing compute-retirement repository's drain/physical-absence proofs, and
the exact PG Workspace identity/capacity inventory at each consequential boundary.
The JSON is configuration, not a boolean permission slip. The root guard does
not infer VM absence from stopped native Pods. The surrounding retirement operator
must have verified native absence before shutting down Cube API/Master/node Pods.

After those online checks succeed, the guard atomically writes and fsyncs
`state/workspace-storage-pool/cold-operation-proof.json`. It binds the exact private
plan file SHA-256 and path, Workspace inventory digest, runtime/source paths,
operation/XFS identity, source inode identities, machine identity and host boot ID.
The second guard call binds the already-created operation journal before the
K3s mount dependency is installed. A proof without that operation binding cannot
authorize an offline start.

For a host reboot that leaves K3s blocked on the incomplete mount, the same fixed
`prepare --plan ...` command can continue that recorded operation without PG or
Kubernetes. The plan must be byte-for-byte unchanged. The machine identity must
match and boot ID must differ. K3s must be inactive/failed with no main/control
PID and `ExecMainStartTimestampMonotonic=0`; no K3s containerd, server or shim may
be running. These checks repeat at every consequential filesystem boundary.
Docker's unrelated build containerd is allowed. A same-boot process crash still
requires live PG/Kubernetes checks, and a K3s process that already ran in the new
boot prevents offline reuse even if it has since stopped.

This reuses previously verified retirement evidence; process absence does not
become evidence of VM death. It permits no new pool journal, changed plan,
Workspace generation, VM effect or PG/quota release. An already-authorized
`preparing` journal can finish its initial image creation under its fixed UUID;
a recorded image that is missing/replaced remains an error. Existing inode,
kernel quota, checksum and retired-directory checks still apply. Offline reuse
never refreshes the proof or grants a runtime execution lease.

The matched wrapper invokes this narrow continuation before using K3s containerd
or PG. After the pool verifies complete, it starts K3s, waits for PG and resumes
ordinary online guards before restoring native workloads. A completed pool needs
only the existing read-only verification for this bootstrap. First installation
does not fabricate a cold proof without PG retirement; no generic offline
administration or `--force` option is provided.

Retry the same `prepare` command after interruption. Copy-stage capacity failures
may use a higher PG revision/capacity in a refreshed plan; identities and capacity
must never regress. Finish an already-started directory handoff before changing
that plan. A changed plan always needs fresh online checks and a new online proof;
it cannot use the reboot continuation. `grow` is only for a completed pool and is safe to retry after a lost
size-change reply. A missing image/journal or foreign inode is an error requiring
operator recovery, not authorization to format a replacement.

Source implementation and written fault tests require serial verification and
real cold-migration acceptance by the release owner. This document does not
claim that a host filesystem or the original Workspace bytes have been migrated.
