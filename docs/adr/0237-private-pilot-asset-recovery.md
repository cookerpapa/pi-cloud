# ADR-0237: Cold conversation-asset recovery before private use

Status: implemented and verified in isolation, 2026-10-07. The owner selected conversation
history and image attachments, with a new Workspace after recovery. Workspace
files, VMs, background processes and old execution grants are outside this scope.
The owner subsequently deferred backups of the current disposable data. The
operator tool/drill is retained on demand, with no backup schedule, destination
or off-machine backup gate for this pilot.

## Reuse and decision

Use the already adopted PostgreSQL and S3 ports. PostgreSQL's maintained
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html) produces a consistent
database archive; [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)
restores it without a new Session format or runtime storage backend. PostgreSQL
uses its existing permissive license. The pinned official PG image supplies the
matching client tools. The existing pinned AWS SDK/SeaweedFS adapter streams
immutable images; verify their application SHA-256 and byte length rather than
treating an ETag as a content hash
([S3 integrity contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)).

A generic backup operator or physical-PV snapshot alone cannot decide which old
PiCloud execution grants and Cube bindings may return. Adding a backup scheduler,
second history format or cross-tenant conversation-import API creates no benefit
for this bounded private-use gate. Retain a small offline operator adapter around
the existing tools instead. This is a cold recovery point, not continuous backup
or physical multi-node HA; future RPO requirements may justify managed PG WAL
archiving and object replication separately.

The source must have no queued/running/recovering work, unprojected seals or open
physical-Session writers. Stop application writers for maintenance. Hold PG table
locks and one exported snapshot through the dump and referenced-image copy; fail
on contention or unsettled state. An incomplete bundle is never a recovery point.
The bundle contains the native PG history plus its dependent product/account
metadata and immutable image bytes. It is sensitive: private directories/files,
no credentials or message bodies in reports, no repository commits. External
provider keys and deployment secrets remain an independent operator responsibility.

Restore only into an empty, offline database and an empty attachment bucket under
a matching source/schema revision. Verify every file before database mutation.
Retain exact canonical native bytes and product history; remove old operational
queues, Worker ownership, routing, resource capsules and Kafka offsets before any
application can connect. Restore must not contact the source Cube or Kafka.
Create fresh empty Workspaces, detach development machines and require ordinary
PG admission for a new user request. Old Workspace metadata may remain only as
deleted historical references, never as a target for physical cleanup.

No recovery procedure deletes source resources or certifies their physical
absence. The restored deployment must use independent Cube/Kafka/storage
infrastructure; do not run two installations against the same external-effect
endpoints. A completed local backup must be copied off the machine before it
protects against machine loss. Checksums detect damage, not malicious substitution;
restore only operator-owned archives from trusted storage.

## Acceptance

Exercise actual pg_dump/restore and separate PG databases and object stores with
synthetic text, image, Tool history and Compaction. Delete/unavailable the source
before reading the restored conversation and hydrating its original images.
Prove that restored state cannot claim old work, has no old VM/lease/Outbox route,
and admits a newly requested Run against a fresh Workspace. Reject active or
unprojected sources, nonempty targets, mismatched schema, missing/corrupt image
bytes and incomplete manifests. Report measured recovery time and evidence scope,
without calling a same-host drill host-loss or cloud failover proof.
