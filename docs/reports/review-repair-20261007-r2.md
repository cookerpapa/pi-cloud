# October 7 post-release source repairs

Implements the four owner-approved findings from the
[post-release review](repository-review-20261007-r2.md), following its
[repair plan](review-repair-plan-20261007-r2.md). Base revision: `59541389`.
This is a source/verification record; the deployed application is still
`review-release-8244934a` / schema 182. No deployment or user-data reset is part
of this implementation turn.

## Resulting behavior

- **R07R2-04:** the composer has one submission-identity owner across ordinary
  send and Steer. An unchanged uncertain retry retains its key; a successful
  intervening action ends the old intent. Fresh identical messages receive a new
  key. Explicit draft reset invalidates the pending identity; late ACKs cannot
  clear a replacement, and draft-revision protection remains.
- **R07R2-02:** the native reader accepts one partition/offset per commit and
  acquires only that partition's guard. Periodic progress has separate in-flight
  tracking per partition. Native commit callbacks still serialize; monotonic
  dispatch positions, current-owner checks, transactional publication and
  commit-before-effect remain. The old multi-partition lock/API was removed.
- **R07R2-03:** the shared guest processor uses pinned Sharp's display dimensions
  and `autoOrient()` before resizing/encoding. Hints describe the actual result.
  Both direct input images and native Tool reads preserve rotations/mirroring;
  immutable original images and existing canonical history are not rewritten.
- **R07R2-01:** [ADR-0235](../adr/0235-upload-staging-recovery.md) was recorded
  before implementation. The shared upload primitive receives a managed staging
  descriptor and preserves hash/length/fsync/no-replace publication. OS-held
  shared locks protect writers; nonblocking exclusive cleanup reclaims abandoned
  temporary names. Gateway startup/periodic scans and guest recovery locators
  survive loss of the original process or PG draft row. Published final files
  and unrelated user `.upload-*` files are preserved.

Upload maintenance belongs to the existing storage owners. The Gateway reclaims
elastic Workspace staging. SandboxProvider rotates bounded cleanup calls over
owned, running development machines; paused/inactive VMs are not woken. Busy
writers are normal deferral, not failure. Cleanup errors neither quarantine nor
destroy VMs. Guest locators contain only path/inode metadata and are not a second
upload payload store, Run authority or execution ledger. No PG migration or new
Kafka topic is required.

The plan was refined during implementation: guest discovery uses derived
filesystem locators instead of PG draft rows, whose expiry/cascade could lose
the only cleanup address. The same shared module is used by both upload paths.
The ordinary Gateway retains its outer Volume admission lock; staging has a
narrower inner lock. Node retains descriptors after the fixed flock utility
exits, and callbacks join before those descriptors close.

## Verification

Combined verification passes: all **22 workspaces** typecheck, **1,649 workspace
tests + 44 acceptance-helper tests** pass, and **217 deterministic fault cases**
pass. The default suite skips nine opt-in cases; the seven RF3/PG transport cases
were also run separately. The owned native guest-helper check below is distinct
from the two opt-in full Provider acceptance cases. A final affected-package
typecheck corrected the maintenance fixture to omit the optional lifetime for
elastic allocation; that focused lifecycle regression was rerun successfully.
Runtime behavior was unchanged by that test-only correction. Evidence includes:

- Actual ChatApp/PiCloudApi browser fixtures pass both lost-response sequences:
  ordinary → Steer → fresh ordinary and Steer → ordinary → fresh Steer.
  Existing full browser acceptance and application build also pass.
- The actual Kafka reader's controlled-callback test preserves healthy
  publication during another partition's held publication. The consumer test
  verifies progress across multiple timer ticks. Seven real RF3/PG transport
  tests pass, preserving zero-SQL ingress/routing and ordered closure contracts.
- A separate RF3 probe lets another partition proceed during a held Tool handoff;
  same-partition work waits. Consumer replacement and replay still hand off the
  Tool once.
- A bounded 32-partition RF3 sample processes 128 records. Current code issues
  **186 ordinary offset commits**, versus **133** for the original `59541389`
  reader/consumer extracted into an isolated test copy. Current sample p50/p95
  publication-to-handler times were **778/1,594 ms**, versus **804/1,808 ms** for
  that baseline. Samples include deliberate 1.1-second gaps and fixture startup
  behavior; they are not fleet SLOs or proof of a latency improvement. The extra
  commits are an explicit cost of independent progress.
- Gateway reproduction: three actual upload-child SIGKILLs, then a cold Gateway
  sweep **without retry**, reclaiming the remaining **65,536 bytes**. A subsequent
  2 MiB retry succeeds with **zero staging orphans**. Shared-transfer/deletion,
  maintenance rotation, same-ID/conflicting publication and replaced-inode
  contracts pass.
- Guest staging tests kill registered writers both before and after publication.
  Reaping an abandoned temporary hard link preserves the final file. Tests cover
  active writers, fresh process recovery, locator replacement, partial
  initialization and more areas than one maintenance batch.
- Real owned Cube VM: freshly bundled input helper running as UID 1000 refuses
  cleanup while a writer holds its lock; after SIGKILL a new helper process
  reclaims **65,536 bytes**, preserves the final file and reconciles an identical
  retry. EXIF orientation 6 yields a **40 × 80** PNG from stored 80 × 40 pixels.
  All eight orientations are checked independently with asymmetric pixel
  fixtures in unit tests. The owned VM's allocation closure and Volume cleanup
  both complete. This tests new guest code on the installed native runtime; it
  is not a matched image rollout or a paid model acceptance.
- Image dependency closure, self-hosted install contract, Helm/distributed
  preflight and runtime time/retention checks pass.

The [machine-readable record](review-repair-20261007-r2.json) and
[fault report](review-repair-20261007-r2-faults.md) separate these new checks from
earlier release evidence. Portable probes live with the
[review reproductions](../../scripts/experiments/review-20261007-r2/README.md);
their original defect measurements remain in the original review JSON.

## Rollout and limits

The new guest input operation requires **guest protocol 4**. Native Tool Worker
reply protocol 3 and managed Cube protocol 7 are unchanged. Build matching
application/Gateway and guest artifacts, refresh template identities, drain old
uploads and retain Gateway Recreate during cutover. Existing old `.upload-*`
files in user directories are not handled by a permanent compatibility scanner.
Any development-data cleanup belongs to the drained, explicitly scoped release.

Continuous writers can defer housekeeping; exclusive lock acquisition, not time
or PG expiry, decides whether cleanup may proceed. Guest transport source files
at `/tmp/pi-cloud-upload-*` retain the existing transfer/helper/EXIT cleanup
contract. This repair does not claim a new dead-writer proof or crash collector
for an independently streaming envd source; sweeping those paths by age would
be unsafe. Physical multi-node filesystem lock recovery and long-duration fleet
load remain separate deployment acceptance work.

The historical host-restart `SetGuestDateTime` timeout was not repaired by this
work. Shared Kafka connection/coordinator failures and same-partition handler
serialization also remain their existing architectural boundaries.
