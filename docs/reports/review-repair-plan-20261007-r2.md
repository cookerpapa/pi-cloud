# October 7 post-release repair plan

Status: approved by the owner, 2026-10-07. This is the implementation plan requested after the
[post-release review](repository-review-20261007-r2.md), not a repair or rollout
record. Source baseline is `59541389`; the reviewed working-tree reports and
reproductions are retained.
The subsequent [source repair record](review-repair-20261007-r2.md) describes
implementation, refinements and validation. It is not a deployment record.

## Scope and authority

Implement four separate, complete slices. Preserve the current authority map:
Pi Durable owns native execution/settlement; PG owns admission and resource
lifecycle; the Session ingress/Kafka/Projector path owns ordered publication and
effect handoff; Cube owns accepted physical operations; Volumes own Workspace
bytes. Each repair belongs in an existing component.

| Finding | Owner of the repair | Intended behavior |
| --- | --- | --- |
| R07R2-04 | Web composer | One submission-identity lifecycle across ordinary send and Steer |
| R07R2-02 | Kafka reader/consumer adapter | A pending partition commit does not reserve other partitions' guards |
| R07R2-01 | Shared upload primitive plus its Gateway/guest adapters | Managed staging can be reclaimed after writer death without deleting active transfers |
| R07R2-03 | Guest image processor | Model image pixels have the same EXIF orientation as normal display |

No change to the Pi Agent Loop, PG Run/lease ownership, Session partition key,
Kafka topic topology or Tool-result authority is needed. Same-partition handler
serialization and broader Cube maintenance remain separately scoped work.

## 1. One composer submission lifecycle

Replace the two `ComposerSubmission` instances with one instance owned by the
open composer. Move the action kind into its input rather than fixing it in the
constructor. Its fingerprint consists of action, Session, Steer target when
applicable, submitted text and ordered attachment IDs.

State transitions:

- Sending an unchanged request whose response was uncertain uses its original
  key, including the original action and target.
- Submitting a different request replaces the current pending identity.
- An ACK clears only the exact pending identity that initiated that request.
  A late ACK cannot clear a replacement's identity.
- A completed submission closes that intent. A later identical intentional
  message receives a fresh key, including when the intervening successful action
  was Steer.
- Explicit composer abandonment/reset ends the pending intent. Mere navigation
  which preserves the same draft must preserve its uncertain retry identity.
  Switching Session or attaching/removing a file changes the submitted identity.
  First-message conversation creation uses the same submission controller after
  the Session has been obtained.

Keep `draftRevision` for protection against clearing edits made while awaiting
an ACK. It has a different job from request identity; keystroke counts are not
server idempotency keys. The backend's existing committed replay lookup remains
the authority for whether a request was accepted.

Files: `packages/web-ui/src/composer-submission.ts`, `ChatApp.tsx` and their tests.
Remove the old separate ordinary/Steer state rather than synchronizing two caches.

Acceptance: actual-browser ordinary X / lost ACK → successful Steer Z → fresh
ordinary X admits both intentional X inputs; cover the inverse sequence, same
request retry, first message, navigation, attachment changes and late ACKs.

## 2. Independent partition progress with confirmed commits

Narrow the internal reader commit API to a single explicit partition/offset.
Use a guard for that partition, shared by its publication transaction and its
dispatch/progress commits. Replace the multi-partition lock acquisition helper.

In `KafkaLogConsumer`, replace the single `progressing` batch with per-partition
in-flight progress tracking. A periodic tick starts work only for partitions
whose processed position advanced and which have no progress commit pending.
Waiting on partition B must neither reserve A's guard nor prevent later periodic
ticks from advancing A. Bound bookkeeping by the assigned partition set, and
join or invalidate it during owner retirement/rebalance.

Keep native commit receipt handling serialized at the point of actual native
commit submission. The current adapter has one shared `offset.commit` callback
slot; blindly parallelizing native calls would confuse confirmation. Importantly,
acquire the relevant partition guard before entering that short receipt queue:
a publication still holding B must not occupy the receipt queue while waiting
for B's guard. Check generation/assignment again after waits and update committed
positions only on confirmation, using monotonic comparisons.

Both periodic progress and commit-before-effect use this primitive. Publication
still preserves the confirmed dispatch offset through the current Kafka
transaction/group metadata. Text processing retains its periodic progress policy;
the repair does not add a synchronous commit per text fragment. An uncertain
native commit still follows the existing owner-retirement path.

This adopts the existing pinned Confluent native client APIs. Its documentation
explicitly distinguishes invoking asynchronous `commit` from confirmed commit
completion: [KafkaConsumer commit APIs](https://docs.confluent.io/platform/current/clients/confluent-kafka-javascript/docs/RdKafka.KafkaConsumer.html).
It does not require a second consumer group or an application task scheduler.

Files: `packages/event-log/src/kafka-partition-reader.ts`,
`kafka-log-consumer.ts` and transport/fault tests. Update internal callers directly;
retain no batch-API compatibility shim.

Acceptance:

- Hold B's publication while repeatedly publishing and processing A. A must make
  progress over multiple timer ticks, not only complete one lucky request.
- Mix Tool dispatch, ordinary progress, old/lower offsets, lost ACKs, callback
  delay, disconnect and rebalance. No effect precedes its confirmed dispatch
  commit and rewind never repeats a committed command.
- Repeat with real RF3 Kafka and the existing zero-SQL ingress/routing checks.
- Measure native commit count and latency at 32 active partitions. Individual
  progress commits can increase requests compared with a batch; quantify this
  tradeoff. The shared Kafka connection/coordinator is still a failure boundary.

## 3. Explicit ownership of upload staging

Keep file placement in `workspace-runtime` and let the caller provide the
staging area and its filesystem exclusion. The shared module handles bytes,
length/hash validation, fsync, atomic publication and cleanup. It must not import
PG, Cube clients or Run-lease logic.

Use a platform-managed staging namespace on the **same filesystem as the final
file**. For ordinary Workspaces, use the existing private Volume envelope outside
the guest-mounted `workspace` directory. For development machines, the fixed
guest adapter supplies a target-filesystem staging area with an explicit managed
identity. Do not assume a machine's arbitrary working directory is the host
Gateway's Volume root, or that guest `/tmp` shares its filesystem.

The common contract is:

1. Validate the existing upload grant and addressed area. Hold shared filesystem
   admission from before creating staging bytes through publication/cleanup.
2. Stream into a unique managed temporary file; validate exact length/hash and
   fsync before linking it to the final destination.
3. Preserve non-overwriting final publication. Existing identical content can
   satisfy a retry; different user content remains a conflict.
4. Normal completion/cancellation removes its temporary name in `finally`.
5. Recovery obtains **exclusive, nonblocking admission for that same area**.
   Success proves no cooperating writer still holds it; only then may it reclaim
   owned staging. A busy area is deferred, not declared dead. Do not upgrade a
   held shared lock to exclusive.

The ordinary Gateway can reuse `gateway.lock`; the guest adapter must supply
its own equivalent OS-held exclusion, not rely on a lock held only by the remote
Control Plane process. Stage ownership and final-file identity remain distinct.
Deleting a leftover staging hard link after publication must leave the final
file intact. Directory/lock inode replacement checks and fd-relative access
remain required.

Recovery must work even if the user never retries. Add bounded maintenance to
the existing owners, with startup recovery and later opportunities after upload
completion/idle. The Gateway can enumerate its private Volume staging areas.
Guest cleanup candidates must be derived from existing upload/resource metadata
through the SandboxProvider boundary, then checked under guest-local exclusion.
The existing upload-expiry sweep must not discard the only cleanup address
before cleanup is confirmed or the owning physical storage is confirmed gone.
Network cleanup runs outside SQL transactions; any subsequent claim deletion
must condition on the observed identity/version/expiry so a renewed upload is
not deleted. No new per-upload execution ledger is warranted.

Before implementation, record a focused ADR refining ADR-0234. Specify the guest
area layout/discovery, lock lifetime/order, cleanup/claim race, protocol changes
if a new guest maintenance operation is necessary, and crash cases. This is the
part of the repair requiring a storage-lifecycle contract; implement both callers
of `writeWorkspaceUpload`, not just the Gateway reproduction. Also account for
the guest transport's `/tmp/pi-cloud-upload-*` source in its own lifetime tests.

Adopt-before-build choice:

- Reuse the installed util-linux `flock` and normal filesystem publication.
  Shared/exclusive exclusion and close-based release are existing OS behavior:
  [flock contract](https://man7.org/linux/man-pages/man2/flock.2.html).
- Keep `link` publication on one filesystem and its no-replace behavior:
  [link contract](https://man7.org/linux/man-pages/man2/link.2.html).
- Linux `O_TMPFILE` could remove orphan lifetime entirely, but requires support
  from every target filesystem and an adapter for `linkat` publication. It is
  not selected as an unverified new requirement for all existing POSIX/guest
  upload destinations: [O_TMPFILE contract](https://man7.org/linux/man-pages/man2/open.2.html).
- PG lease expiry or a filename/age sweep alone does not establish filesystem
  writer death. Reuse current ownership and OS locks rather than invent another
  distributed lease or garbage-collection service.

Acceptance: repeated SIGKILL before/after fsync, after link but before cleanup,
lost HTTP response, same-ID retry, no retry, renewed claim racing cleanup, two
live upload processes, continuous unrelated uploads, deletion exclusion and
replaced directories. Both ordinary Workspace and dedicated-machine uploads
must pass. Active transfers and final files survive; abandoned staging is
eventually reclaimed once exclusion is obtainable. Do not claim a reclamation
deadline under an indefinitely busy area.

Remove the old named staging path in the user upload directory. Existing
development-only remnants can be inventoried and removed during a drained,
scoped cutover; do not ship a permanent compatibility scanner for arbitrary
user-visible `.upload-*` filenames.

## 4. Apply image orientation once, in the shared processor

Use pinned Sharp **0.35.4**'s `metadata().autoOrient` dimensions to determine
the displayed width/height, then `.autoOrient()` before resizing and PNG
encoding. Do not add hand-written EXIF rotation tables. Use output metadata for
the reported model dimensions. The same processor serves direct attached images
and fixed Tool reads.

Sharp already handles EXIF rotations and mirroring:
[autoOrient API](https://sharp.pixelplumbing.com/api-operation/#autoorient).
Preserve current model-image size policy, original S3 source bytes and claim-check
transport. Correct newly normalized content without rewriting previously
committed native history.

Files: `packages/tool-sandbox/src/image-processor.ts` and image/input tests.
Acceptance uses an asymmetric colored fixture for all eight EXIF orientations,
checking pixels as well as dimensions, both resize settings and both callers.
Include ordinary PNG, corrupt input and a larger resized image.

## Implementation and release order

Recommended implementation sequence: composer identity → partition commits →
image orientation → upload staging. Each slice replaces its old implementation,
turns the relevant defect characterization into a positive regression, and passes
its own tests before moving on.

After all slices: workspace typechecks/tests, browser flows, RF3 transport,
deterministic faults, guest image closure, install/Helm/documentation checks and
the measured concurrency cases. Use GPT-6 Luna for any live model acceptance;
most failure/orientation assertions do not require paid inference.

Changes to image normalization and the shared upload primitive affect the guest
bundle. Build matching application/Gateway and guest artifacts, regenerate guest
identity/templates, and use the existing release provenance checks. If the guest
maintenance wire changes, update its version and deployment acceptance together.
Drain old Gateways and affected upload operations for the layout cutover; keep
the current Recreate policy. A database migration is needed only if the final
ADR demonstrates that existing upload cleanup fields are insufficient; it is not
assumed as a prerequisite. Deployment remains a subsequent, separately executed
step with owned browser/upload/Tool/image acceptance.

The historical host-restart `SetGuestDateTime` timeout remains a separate
diagnosis: correlate cold-host Cubelet/shim/guest timing before proposing a
timeout/retry change. It must not be labeled fixed by these four repairs.
