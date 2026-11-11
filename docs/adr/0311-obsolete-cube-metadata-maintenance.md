# ADR-0311: Bounded retirement of obsolete Cube metadata

Date: 2026-11-11. Status: accepted. Tracking: [#28](https://github.com/cookerpapa/pi-managed-agents/issues/28).

## Evidence and choice

Four superseded templates retain a Cubelet Pod address from an earlier rollout.
Native template deletion and artifact placement prefer this address; they resolve
the stable node ID only when the stored address is empty. The installed native
CLI offers no locator override. Deleting database ownership or rootfs files to
make the request appear successful would bypass native cleanup.

Use a one-time cold maintenance command, not a Cube source patch or runtime
reconciliation service. It reuses the existing release lock, PG drain checks,
compute retirement, native workload stop record and native deletion API. Preserve
accounts, configuration, stable machine intent and Workspace bytes. Pause all
native template writers, including TemplateCenter, before repairing locators.

An explicit list of obsolete template IDs excludes every selected current
template. Require terminal jobs, one verified physical node, and no artifact
references from another template. Clear only the selected obsolete replica/job
and artifact-placement addresses in a guarded MySQL transaction. Keep ownership,
IDs and artifacts until the ordinary native delete operation confirms cleanup.
Failure leaves the template pending. Current templates are not rewritten.

## Inactive node extension buckets

The removed private patch created four top-level bbolt buckets:
`pi-cloud.allocations.v1`, `pi-cloud.lifecycle.v1`,
`pi-cloud.resource-usage.v1` and `volume_reference_state`. Pinned stock Cube does
not use them. In particular, native `volume_refcounts` is **not** in this list.
The first three belong to containerd `meta.db` (native `v1` bucket); the last
belongs to `io.cubelet.internal.v1.storage/db/volume_refcount.db` (native
`volume_refcounts` bucket). Each database has its own exact allowlist and hash.

After compute absence and native writer shutdown, use upstream bbolt 1.4.3's
exclusive file lock and a single `DeleteBucket` transaction. Require an existing
regular database at the maintained Cubelet path; never create a missing database.
Hash all retained bucket names, sequences, keys and values before/after inside
the transaction. A failed check rolls back. Unknown buckets remain untouched.
This removes obsolete private records, not Workspace data or native references.
Do not implement a new database parser, force-open a live database or retain a
legacy business backup. bbolt's normal transaction recovery handles interruption.

## Validation and recovery

Tests cover protected/shared templates, changed rows, live file locks, missing
databases, retained nested data, idempotence and rollback. The operator persists
original workload identities/replicas before stopping; retries resume the same
maintenance record. Restore the native roles before ordinary template deletion,
then restore the application and verify original files/configuration, current
templates and recovered machine intent. This does not upgrade runtime images,
alter their release evidence, or change accounting's unconfirmed/unpriced policy.

Adoption evidence: Cube pinned source `4411c96b`,
`CubeMaster/pkg/templatecenter/delete.go` and `artifact_lifecycle.go`;
removed patch inventory in `e1eaeb1d`; upstream
[bbolt transactions and file locking](https://github.com/etcd-io/bbolt).

The maintained command is `scripts/retire-obsolete-cube-metadata.mjs`, run as
host root with the TypeScript loader, an empty private evidence directory, the
binary built from `scripts/cube-metadata-cleanup`, and exact obsolete template
IDs. Build/test that helper with `go test ./...` and `go build -o PATH .` in its
module. Reuse the same directory and arguments after an interrupted operation.
The saved stage and workload UIDs prevent a retry from adopting another release.
