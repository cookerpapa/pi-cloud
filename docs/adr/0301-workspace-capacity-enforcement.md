# ADR-0301: Persistent Workspace capacity with kernel enforcement

Status: accepted; deployed and verified on 2026-11-07.
Date: 2026-11-07. Tracking: [Issue #8](https://github.com/cookerpapa/pi-cloud/issues/8).

## Product and authority

The displayed storage capacity means persistent Workspace capacity, independently
of the disposable VM system layer. Elastic and dedicated compute use the same
definition. The initial default is 32 GiB, configurable by deployment; users can
increase a Workspace's capacity independently of CPU/memory. This slice supports
growth, not destructive shrink. Existing files must fit the assigned initial
capacity; migration raises that assignment when needed rather than truncating data.

PG stores requested capacity, its monotonically increasing revision and whether
delivery still needs reconciliation. The latter is a command-delivery checkpoint,
not a copy of physical disk usage. The storage endpoint owns applied revision
receipts and reads actual limits/usage from the filesystem. Persistent Cube
Volumes remain the only Workspace byte authority. No per-Run archive or file
replication head is added. Capacity changes use direct resource management; they
do not add noise to a native Session log.

## Adopt-before-build evaluation

- OpenEBS LocalPV Hostpath uses XFS project quotas for directory capacity. Adopting
  its whole PVC provisioner would add a second Volume lifecycle owner beside
  Cube; its documented resize interface does not replace this product's existing
  Volume/file ports. Reuse the kernel quota mechanism, not another provisioner.
- CephFS subvolume quotas are suitable for a Ceph-backed deployment, but adding a
  Ceph cluster solely for this single-host storage limit adds substantial operating
  cost. A later backend belongs behind the same PiCloud quota port and needs its
  own current ADR and acceptance.
- Moby's maintained quota implementation is an internal package, not a stable
  embedded public API. Do not depend on Docker daemon internals or its socket.

Use Linux XFS project quotas and a small descriptor-based kernel adapter. The
`quotactl_fd` interface avoids relying on a container's device paths or a matching
host mount namespace. Linux 5.14+ and project accounting/enforcement are required;
unsupported mounts fail explicitly, without an unlimited fallback.

References checked 2026-11-07:
[OpenEBS XFS quota](https://openebs.io/docs/main/user-guides/local-storage-user-guide/local-pv-hostpath/advanced-operations/xfs-quota/enable-xfs-quota),
[project directories](https://man7.org/linux/man-pages/man5/projects.5.html),
[Ceph subvolumes](https://docs.ceph.com/en/latest/cephfs/fs-volumes/),
[OpenEBS quota ownership fixes](https://github.com/openebs/dynamic-localpv-provisioner/releases).

## Privilege and filesystem boundary

A narrow trusted storage helper performs quota operations. It shares the Volume
Gateway build artifact but is a separate process with only the mounted Workspace
storage and required kernel capabilities. File gateways retain their unprivileged
identity. The helper receives fixed typed operations, never user programs, shell
commands or model/provider credentials. Its private service uses the existing
Workspace service credential; receipt delivery uses the dedicated accounting key.

All managed Workspace data and upload staging data use the same project ID.
Quota, deletion and accounting metadata remain outside that project so a full Workspace can still be
cancelled, expanded or deleted. Quota limits are installed before a new tree is
published as usable. An immutable generation-bound enforcement marker proves that
initial setup completed; it is not a mirror of changing capacity or usage.
Ordinary file writes are enforced by the kernel, without a SQL/HTTP check per write.

Mutations retain the existing Volume admission lock and a quota mutation lock.
Recheck generation/revision after acquiring them. Kernel calls execute in the
lock-owning process, so process loss cannot release the lock while a detached old
setter continues. A pending local receipt precedes kernel mutation; retries inspect
the actual result and safely apply the same requested configuration. Lower stale
revisions cannot overwrite a newer applied limit.

Clearing a quota requires confirmed directory absence and zero accounted inodes
and blocks on the same filesystem. It cannot release Cube references, destroy a
VM or substitute for physical Volume deletion. Quota project IDs remain backend
details, never cloud Run/Session identities.

## Storage and deployment

The current host has an ext4 Workspace directory without project-quota support.
Use a dedicated quota-enabled XFS pool for the existing Volume directory; do not
alter the host root filesystem's feature flags. The single-host installer uses
an XFS backing file, with an explicit persistent mount dependency before K3s.
The quota is a hard capacity ceiling, not a promise of preallocated physical
blocks or node-level HA; deployment operators still size the backing pool.

An existing deployment must drain writers, uploads and VM references before the
filesystem handoff. Copy and verify the existing bytes/metadata, mount at the
maintained path, restart all consumers and remove the verified obsolete staging
copy. Never mount an empty replacement over live user data or silently recreate
a missing pool. The source adapter supports growth of the pool, not shrink.

### Reboot during the authorized cold handoff

The K3s mount dependency intentionally prevents startup before the canonical XFS
mount is usable. A host reboot during staging can therefore leave the PG and
Kubernetes services needed by the ordinary migration guard unavailable. The
operator may finish that same, already-authorized cold filesystem operation using
a finite local proof; this is not a general offline administration mode.

Before filesystem effects, a successful online guard atomically fsyncs a private
proof under the pool's control directory. It binds the exact private plan SHA-256,
runtime/source paths, metering source, Workspace identities/generations/revisions/
capacities, current host boot ID, schema 212, settled uploads, PG retirement
receipts and verified stopped writer/native workloads. These checks must actually
have succeeded. A plan's booleans or missing Pods cannot create that proof.

Offline reuse requires the same machine identity with a different host boot ID,
the identical frozen plan and an existing matching unfinished pool journal.
K3s must be inactive with no main or control process and must not have started in
that boot. The host process inventory must contain no K3s containerd or its shims;
Docker's unrelated build daemon is outside this runtime stop condition.
The proof authorizes only continuation of the recorded filesystem operation;
existing inode, XFS UUID, quota, checksum and retired-directory guards still apply.
It cannot authorize a VM operation, PG mutation/quota release, changed plan,
different pool journal or recreation of a recorded missing image. The initial
image creation of an already-bound preparing operation retains its assigned UUID.
A normal process crash in the same host boot still
requires fresh online PG and Kubernetes checks, even if those services are down.

This relies on the maintained single-host release boundary: runtime/native
writers were stopped and their managed physical allocations were positively
retired before the proof was recorded. Host reboot and current process absence
only establish that those writers cannot have resumed through the blocked K3s
service; they are not new evidence of VM death. Once the verified pool is ready,
the matched operator starts K3s and returns to ordinary online checks before
restoring native workloads. The proof is maintenance evidence, never a renewable
execution lease or another durable control authority.

## Metering and acceptance

The storage helper reuses the source receipt journal under ADR-0300, independently
of management availability. Meter enforced capacity over retention time once per
Volume generation, including while VMs are paused or reclaimed. Unknown source
coverage stays unconfirmed. Model, compute and storage dimensions share account
and price rules, not a common execution scheduler.

Verify real Bash/terminal and upload exhaustion, successful growth and resumed
upload, stale revision rejection, setter interruption, source/receiver restart,
shared-Workspace counting, safe deletion and original-byte preservation. A label
or API-only upload limit is not acceptance of storage enforcement.

Resumable upload receivers reserve 128 KiB of temporary physical recovery space
per active transfer. If a metadata commit encounters EDQUOT/ENOSPC, it overwrites an inactive
preallocated slot and atomically exchanges it with canonical metadata using
Linux renameat2(RENAME_EXCHANGE). The old canonical allocation becomes a reusable
slot; renewals cannot consume a finite recovery allowance. Both are 64 KiB, and
the exchange helper inherits the existing transfer lock so an old process cannot
finish its swap after a successor has taken ownership. Initial creation reserves
two slots before publishing the first canonical value. Terminal
transfers and existing staging collection reclaim it. This also covers the fixed
guest receiver without changing its filesystem/receiver identity or adding another
upload route. Unchanged status reads do not rewrite metadata.

[Matched delivery and validation limits](../reports/runtime-accounting-20261107.md).
