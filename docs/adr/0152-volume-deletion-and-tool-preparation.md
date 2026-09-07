# ADR-0152: native Volume deletion and visible Tool preparation

Accepted, 2026-09-06. Extends ADR-0151.

## Volume deletion

The uid-1000 Volume gateway cannot unlink arbitrary root-owned Guest trees.
Recursive deletion can also remove trusted identity metadata before failing.
Do not solve this by running the whole gateway (including Git operations) as
root, adding a privileged GC service, or relying on a live Guest for cleanup.

Use Cube's existing Controller Volume Destroy hook. Its documented contract
owns backend deletion; Cube rejects deletion while the volume has references.
See [Cube Volume Plugin](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/volume-plugin.md).

1. Broker proves the Workspace is deleted and no runtime/terminal is live.
2. Unprivileged gateway verifies the trusted envelope and atomically persists a
   generation-bound deletion marker outside the Guest mount. No user bytes or
   identity metadata are removed here. Further prepare/read/write/fork fails.
3. Cube DELETE invokes the existing POSIX plugin with its normal storage
   privileges. The hook requires the marker, checks the fixed volume path,
   refuses symlinks at the root, and removes only `workspace/`, not the envelope.
   GNU `rm --one-file-system` does not traverse nested filesystems or symlinks.
4. After Cube DELETE succeeds (or returns 404 on a retry), gateway verifies that
   Guest bytes are absent, removes its own envelope, and Broker marks PG purged.

The marker and original identity remain until the privileged phase succeeds.
An interrupted delete, Cube 409, lost response or failed final PG commit can
retry the same phases. No cancelled deletion is revived as a new Workspace.
Storage backends still need their normal deletion authority (for example an
NFS export must permit the Controller's service identity to remove all UIDs).
No new broad host mount, Docker socket or privilege is given to PiCloud.
The plugin must be updated before deploying the new gateway; an old plugin
fails closed instead of deleting a nonempty envelope.

## Tool preparation

Keep incomplete arguments out of Kafka/PG and out of execution. Resolve only
stable Tool identity from Pi's start/delta notifications and emit one preparing
event per call, even if the provider supplies its name after the start event.
Write/edit show generation-specific, animated activity with elapsed time,
explicitly distinguished from execution. Complete Tool start/result replaces
the same row; cancellation and validation failure leave no orphan spinner.
Use the same durable live-tail/reconnect mechanism for Bash, read, write and edit.

Live testing also exposed a second-Turn Responses failure: a false reset fact
inserted between a function call and its result made Pi's protocol converter
synthesize a missing result, then send the actual result again. Elastic runtime
continuity now uses the allocation identity both before and after materialization;
the Runner takes the Broker's actual binding identity instead of its Attempt ID.
World State changes observed during a Tool are published only at the next clean
sampling/settlement boundary, after its result. Do not deduplicate arbitrary
provider payloads or hide the underlying ordering defect.

## Acceptance

Root-owned 0700/000 files, symlinks, missing/wrong marker, partial deletion,
Cube 409/lost ACK, and finalizer refusal while user bytes still exist. Verify
both native Controller plugin and gateway contract with disposable storage.
Exercise write/edit preparation with delayed stream chunks, reconnect and
completion; run a paid coding round through the public API and browser renderer.
