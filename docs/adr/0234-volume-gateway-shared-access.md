# ADR-0234: Shared Volume access with exclusive lifecycle and credential mutation

Status: implemented, verified and deployed, 2026-10-07.
[Source repairs](../reports/review-repair-20261007.md) and
[matched rollout](../reports/review-release-20261007.md). The owner authorized the
October 7 review improvements. This refines ADR-0231's exclusion granularity;
it does not change Workspace ownership, PG admission or Cube deletion authority.

## Evidence and adoption

O07-01 reproduced directory-read timeout while another Gateway held the Volume
lock through a suspended upload. Keep the existing pinned util-linux `flock`
adapter and use its shared/exclusive modes, rather than introduce another lock
service or a lease that can expire during continuing filesystem effects.

The [Linux flock contract](https://man7.org/linux/man-pages/man2/flock.2.html)
supports concurrent shared holders and excludes an exclusive holder. Locks live
with the open file description, not a PG connection. Mode conversion is not
atomic, so this design never upgrades a held shared lock. The existing
[util-linux utility](https://man7.org/linux/man-pages/man1/flock.1.html) supplies
bounded acquisition through a Node-owned descriptor.

Uploads already write a unique temporary file, validate length/hash, fsync and
publish with [link(2)](https://man7.org/linux/man-pages/man2/link.2.html), which
does not replace an existing destination. An identical retry verifies the
existing file; conflicting content fails. This existing placement primitive
and PG upload identity avoid a new per-file lock registry. Credential updates
are read-modify-write operations on one shared file and still require exclusion.

## Contract

- Every Gateway access to an existing envelope uses filesystem exclusion. Remove the process-local
  whole-Volume queue and the option to silently run with that queue alone.
- Verification, directory/file reads and upload transfer/publication hold a
  shared `gateway.lock` until the callback settles. Different uploads and reads
  can proceed together, within one process or across Gateways.
- Credential reads and mutations acquire shared `gateway.lock`, then exclusive
  `credentials.lock`. Always use that order. The second lock covers only the
  credential-file callback; remote Git credential probes remain outside it.
- Deletion preparation/finalization holds exclusive `gateway.lock`, without a
  credential lock. Preparation therefore waits for active transfers/readers and
  credential updates before publishing the deletion marker. Later operations
  verify that marker and refuse admission. PG closes upload/attachment admission
  and Cube proves physical reference release exactly as before.
- Both lock files are derived zero-content files in the existing trusted Volume
  metadata directory, outside the guest mount. Verify each acquired inode still
  belongs to the addressed envelope. Never unlink a live lock or initialize a
  missing/malformed Volume to obtain one. Only exclusive deletion may run an
  already-absent callback. Root-directory listing may observe absence and return
  an empty list before acquiring any lock, preserving the existing empty-Workspace
  API. That read does not initialize storage or establish physical absence for GC;
  other operations and an envelope disappearing during acquisition still fail.
- Open descriptors remain owned by Node after the acquisition child exits and
  until callback completion. Process death releases them; PG loss does not.
  Acquisition timeout fails without running the callback. No background work
  may outlive a callback and continue filesystem mutation after releasing its lock.
- No fairness or bounded total deletion latency is promised. A continuing upload
  can delay deletion; bounded lock acquisition/reaper retries retain the resource.
  A timeout never proves VM/Volume absence or releases quota.
- These locks coordinate trusted Gateway operations, not arbitrary guest Bash.
  Shared files retain ordinary Linux concurrency. Actual cross-node filesystem
  locking still needs deployment-specific validation under ADR-0231.

## Cutover, rollback and acceptance

The Gateway remains a `Recreate` Deployment. Drain old Gateway processes before
replacing or rolling back their binaries. Old zero-content lock files remain
inert derived metadata and disappear with the retired envelope. No data-copy,
new PG authority, Kafka stream, per-file ledger or native Cube patch is added.

Verify a slow upload permits unrelated reads, another upload and credential
updates, while deletion waits. Cover conflicting/duplicate upload destinations,
credential read-modify-write exclusion, callback exceptions, a killed shared
holder, PG disconnect, replaced lock/envelope inodes, absent/unpublished Volumes
and idempotent deletion. Preserve the plugin-owned initialization and versioned
Cube reference recovery tests.
