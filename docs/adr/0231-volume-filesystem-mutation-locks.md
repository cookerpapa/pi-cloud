# ADR-0231: Volume Gateway filesystem mutation locks

Status: implemented, verified and deployed, 2026-10-06.
[Source verification](../reports/review-repair-20261006.md) and
[matched release](../reports/review-release-20261006.md).
The owner authorized the post-Durable review repairs. This decision addresses
R06-03 without changing Workspace byte ownership or VM lifecycle authority.

## Evidence and adoption

The existing PG advisory lock is tied to a database connection. Losing that
connection releases the lock while the Node filesystem callback can continue.
Rejecting its result afterwards cannot protect another Gateway's file update.

Adopt Linux `flock` through the existing util-linux executable, behind the
PiCloud-owned `WorkspaceVolumeGatewayLock` port. The digest-pinned Node 24.18.0
Bookworm image contains util-linux 2.38.1; assert that binary version in the
Gateway image. The project is maintained at
[util-linux](https://github.com/util-linux/util-linux), with the
[flock implementation](https://github.com/util-linux/util-linux/blob/v2.38.1/sys-utils/flock.c)
under BSD-4-Clause. No new lock service or Node native addon is required.

The [Linux contract](https://man7.org/linux/man-pages/man2/flock.2.html) associates
the lock with an open file description. Pass a Node-owned file descriptor to
the fixed `flock` child; after successful acquisition, the parent keeps that
descriptor open until its callback has joined. Child exit does not release the
parent's lock. Parent death closes the descriptor. Use a regular writable lock
file, since exclusive NFS locking requires write access; a directory descriptor
would not satisfy that boundary on every supported shared filesystem.

Considered [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)
(MIT): its directory/mtime stale recovery can grant a successor before a paused
old callback finishes, so it does not supply the required exclusion. PG locks
remain appropriate for PG transactions, not for independently continuing POSIX
effects. A new distributed scheduler/lease service has the same fencing gap
without a filesystem-enforced write contract and would add operational cost.

## Contract

- Each existing plugin-owned Volume envelope has one derived, zero-content
  `gateway.lock` in its trusted `.pi-cloud-runtime` directory. Creating this
  lock does not create/repair a Volume or grant access. It is outside the guest
  Workspace mount and removed only when the complete retired envelope is removed.
- Open the existing Volume/metadata directories without following symlinks;
  open the lock without truncation. Verify the path still names the held inode
  after acquisition. A waiter on an unlinked/replaced envelope cannot mutate its
  successor. Never unlink a live lock file to implement stale-lock recovery.
- Acquire exclusively with bounded waiting. Run the callback only after the
  fixed utility succeeds. Close the held descriptor after the callback settles,
  on success or error. No heartbeat or wall-clock lease expires a held lock.
- Only prepare/finalize deletion may handle an already-absent envelope without
  a lock: they return absence / remove an already-retired immutable-ID envelope.
  Ordinary file and credential requests still fail if the Volume is absent.
  A present but malformed envelope remains an error, not deletion evidence.
- Keep the current PG upload/admission and Cube attachment/deletion checks.
  These locks serialize trusted Gateway operations only; arbitrary Agent Bash
  and shared Workspace access retain ordinary user-managed Linux concurrency.
- Shared storage must implement cross-client `flock`, including lock recovery
  and I/O failure semantics. NFS local-only locking is unsupported. Test the
  actual backend across nodes before claiming physical multi-node HA. Do not
  silently fall back to PG/mtime locks if filesystem locking fails.

## Cutover and acceptance

Remove the PG lock implementation and its connection-pool requirement. The
Gateway keeps ordinary PG access for upload authorization. Use Deployment
`Recreate` so old PG-lock and new filesystem-lock replicas never overlap during
this matched cutover or rollback. Workspace bytes and Volume identities remain
unchanged; no data migration or release of historical UNKNOWN resources is needed.
Rollback also drains Gateways first; leftover zero-content lock files are inert.

Verify separate-process exclusion, independent Volumes, wait timeout, exceptions,
SIGKILL holder recovery, callback continuation after PG loss, replaced/deleted
inodes and idempotent deletion. Exercise credential read-modify-write and real
upload/GC flows. No test may infer physical VM absence from loss of a lock owner.
