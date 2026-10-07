# October 7 post-release repository review

Reviewed revision: `59541389d26a8f4c4e982f27e645a18b8e89892f`, branch
`migrate/pi-durable-1.0`. Deployed application source:
`8244934ad7d080db50c204d827c9ccf6ac4d3afd`, schema
`182_conversation_activity_page`. The difference between those revisions is
release documentation/acceptance scripts; package source, dependency lock and
deployment manifests are unchanged. The initial working tree was clean.

This review covers all eight agreed areas and all **22 workspaces** against the
1,639-file tracked inventory. Coverage follows active data flows, component
contracts and failure boundaries; it is not a claim that every historical
migration was re-audited line by line. Earlier owner discussions and ADRs were
used to distinguish intentional behavior from defects. No private conversation
transcript or credentials are included.

There are **four confirmed P2 findings** below. This turn records findings and
executable characterizations; it does not implement product repairs or deploy
changes. Previously resolved findings remain resolved unless explicitly called
out here.
The subsequent [approved source repair](review-repair-20261007-r2.md) implements
the four findings. Original review evidence remains unchanged below.

## Confirmed findings

### R07R2-04 — P2: a fresh message can inherit an older uncertain request identity after Steer

**Example.** While an Agent is running, the user presses Enter to queue message
X. The server accepts X but its response is lost. The user changes the draft to
Z and successfully sends it with Steer; the composer clears. Later the user types
X again and presses Enter, intending another message. The second ordinary send
reuses the first X's key, so the server replays the old admission instead of
creating the new one.

`packages/web-ui/src/ChatApp.tsx:247` creates separate `ComposerSubmission`
instances for ordinary send and Steer. The calls at `:1224` and `:1316` only
update their own instance. `composer-submission.ts:19` retains an unresolved
fingerprint until that instance sees a different submission or an ACK. A
successful intervening Steer never ends the ordinary draft's identity.

**Evidence.** The actual ChatApp DOM and PiCloudApi ran in the maintained browser
fixture. Two ordinary requests surrounding one successful, different Steer had
the same key: **one ordinary admission and one Steer admission**, although the
last ordinary message was a fresh user action. The fixture records admission
before dropping the first response. The existing backend replay contract is
correct; this reproduction does not claim a live production Run.

**Repair direction.** Make submission identity follow the composer's intent
lifecycle across both actions, including Session, target Turn and attachments.
Keep the immutable identity of an unchanged uncertain retry, but do not let it
become the identity of a fresh draft after another submission has succeeded.
This is a client-state repair, not prompt-text deduplication or a server protocol
change.

**Acceptance.** Test ordinary → Steer → fresh ordinary and the reverse; unchanged
retries still admit once, intentional identical new messages admit separately,
and late ACKs never clear later edits. Include navigation and attachment changes.

### R07R2-02 — P2: periodic offset batches couple otherwise independent partitions

`packages/event-log/src/kafka-log-consumer.ts:403` gathers processed offsets from
all assigned partitions into one periodic commit. In
`packages/event-log/src/kafka-partition-reader.ts:307`, that commit acquires
partition locks through `#withCommitLocks` at `:355`. Locks already acquired stay
held while it waits for the next partition. Publication uses those locks too.

**Example.** A slow publication holds partition 1. A periodic commit covering
partitions 0 and 1 acquires partition 0, then waits for partition 1. A new healthy
partition-0 publication now waits behind that batch. The batch has expanded one
partition's delay into another partition's publication path.

**Evidence.** A deterministic probe runs the real `KafkaPartitionReader` with
controlled native callbacks. Without the multi-partition batch, partition 0
finishes while partition 1 is held. With the batch, it finishes only after the
controlled approximately 120 ms hold is released. This is a lock-scheduling
reproduction, not measured broker failure latency.

The separate real RF3 probe confirms ordinary handler isolation: another
partition proceeds while one Tool handoff is held; another Session in the same
partition waits. Consumer replacement and a rewind below the dispatch boundary
do not hand off the Tool again. These observations are compatible: handler
isolation works, while the periodic commit introduces a different coupling.

**Repair direction.** Keep progress commits from reserving unrelated partition
locks while waiting for a busy partition. Preserve monotonic offsets, current
group-member fencing and commit-before-effect. The native commit callback is
shared, so simply issuing overlapping native commits is not a safe repair.

**Acceptance.** Hold one publication indefinitely in a fixture; another partition
must continue publishing while periodic progress runs. Combine this with lost
commit replies and assignment replacement; no offset regression or duplicate
Tool dispatch is permitted.

### R07R2-01 — P2: a killed upload process leaves permanent staging bytes

`packages/workspace-runtime/src/upload-file.ts:45` creates a fresh random
`.upload-*` file inside the upload's Workspace directory. Cleanup at `:101` is
in `finally`. A SIGKILL cannot execute it, and a retry creates another random
staging file. The current upload-claim/attachment reaper expires PG/S3 state; it
does not reclaim these files from the Workspace Volume.

**Example.** A large upload is interrupted by a Gateway crash, then successfully
retried. The user sees the completed file, but the partial first copy still
occupies disk. Repeated crashes accumulate more copies for the same upload ID.
The files are hidden staging names, not retained conversation assets.

**Evidence.** The actual Gateway, POSIX Volume fixture and filesystem lock were
used. Three child processes were killed after each had written 64 KiB, followed
by a successful 2 MiB retry with the same upload ID. After Gateway closure the
completed file was present alongside **three orphan files / 196,608 bytes**.
Authorization was a fixture callback; this does not model the entire HTTP/PG
claim flow or a physical host power loss.

**Repair direction.** Give upload staging an explicit crash-recovery lifecycle
within the existing Workspace/Gateway ownership boundary. Reclaim demonstrably
abandoned staging while preserving concurrent live transfers and atomic,
non-overwriting finalization. Age alone must not authorize removal of a live
upload, and user files must not be treated as staging by filename alone.

**Acceptance.** Repeated process loss, uncertain completion, same-ID retries,
simultaneous distinct uploads and deletion exclusion leave neither unbounded
staging bytes nor a damaged final file. Preserve ADR-0234's shared access.

### R07R2-03 — P2: image normalization drops EXIF orientation without applying it

`packages/tool-sandbox/src/image-processor.ts:33` reads stored pixel dimensions
and re-encodes to PNG without applying EXIF orientation. Re-encoding removes
the orientation metadata. The path is shared by direct user-image preparation
(`input-files.ts:24`) and image reads (`native-tools.ts:145`).

**Example.** A phone photograph is stored sideways with metadata telling viewers
to rotate it. A normal browser displays it upright, but the normalized image
given to the model is sideways. Questions about position or screenshot layout
can therefore refer to different visual coordinates.

**Evidence.** A synthetic JPEG has stored dimensions 80 × 40 and orientation 6.
Applying its display orientation produces 40 × 80. The actual processor returns
an 80 × 40 PNG with no orientation metadata. No model inference is needed to
establish the changed image geometry. This is PiCloud's normalization behavior,
not an assertion that native Pi promises a particular Sharp configuration.

**Repair direction.** Apply orientation before selecting resize dimensions and
encoding. Keep the existing model-output size policy and immutable original source.

**Acceptance.** Cover EXIF rotations and mirrored orientations through both
callers; model dimensions and displayed orientation agree, while ordinary PNGs
and image-size behavior remain correct.

## Architecture assessment

The current authorities remain coherent: native Pi owns Harness/Task progress;
PG owns cloud admission, leases and resource lifecycle; the physical Session
writer publishes through fenced ingress; Kafka orders accepted facts; one
Projector group materializes history and routes effects; Cube owns accepted
physical operations; persistent Volumes own Workspace bytes. This review found
no justification for another execution scheduler, Tool-result ledger or broker.

The useful optimization boundary is still **hot ordered views versus lifecycle
authority**. Source inspection and unchanged-source RF3 evidence retain zero-SQL
ordinary ingress/binding reads. Recovery, closure and resource deletion still
need current PG authority. The deep-pagination probe confirms that the recent
query change avoids aggregating unrelated Sessions' history without introducing
another count table. More caches are not automatically an improvement.

Three tradeoffs deserve continued attention:

1. **Partition isolation has two distinct limits.** R07R2-02 is avoidable lock
   coupling and should be repaired first. Same-partition handler serialization
   is an intentional existing limit, now demonstrated with RF3: a blocked Tool
   handoff delays other Sessions there. Moving that work to a per-Session pump
   would require an ADR covering dispatch offsets, rebalance, cancellation and
   in-flight ownership, plus build-versus-adopt evidence. Untracked background
   promises are insufficient. A single local sample does not establish p95 or
   fleet capacity.
2. **Shared code does not by itself unify state ownership.** The recent composer
   helper removed duplicated logic, but separate instances still disagree about
   the lifecycle of one draft. R07R2-04 is a concrete example. Likewise, lifecycle
   decomposition should preserve one owner for creation, retirement and physical
   absence, rather than move fragments into new services merely to shorten files.
3. **Cube remains a maintained native integration.** Six pinned patches implement
   execution handoff/completion, ordered admission, recoverable allocation,
   Volume reference recovery and node-address-aware cleanup. The current Helm
   renderer and release identity checks improve maintenance; this is still more
   than a Node/Bash wrapper. Keep explicit contract/version acceptance when
   upgrading Cube. Current template cleanup uses stable node identity, and the
   earlier cleanup timeout is not reclassified as an unresolved defect here.

## Native Pi and recovery review

The comparison uses installed, pinned `@earendil-works/pi-durable`, `pi-ai` and
Chord **1.0.0** source. The pre-Durable local Pi checkout is historical evidence.

- Native `ToolTask` validates, runs policy hooks, revalidates and commits execution
  intent before `execute`. PiCloud's remote hook adds handoff to that commit;
  it does not replace the Agent Loop. Unsafe Tool recovery produces an interrupted
  result instead of automatically repeating shell work.
- Native abort owns canonical settlement. The same Session path carries physical
  operation cancellation; a late reply cannot overwrite that native result.
  A cancellation ACK is not proof that a process or VM is absent.
- One Harness/Storage owner serves the physical Session's Conversations. Cloud
  grants are installed before resumed sampling, including Compaction recovery.
  PG closure admits the replacement lease while the logical Run stays the same.
  There is no need to restore RunAttempt or a per-Lane lease.
- Models-port suppression of incomplete Tool drafts is the explicit ADR-0230
  policy. Full validated calls, text streaming and native storage remain separate
  concerns. Automatic background Compaction outside a cloud admission and
  user-loaded extensions remain documented product limits.
- Queue Stop returns unconsumed human input to the composer under ADR-0229.
  Browser-local draft recovery is not a durable draft service. Existing recovery
  tests cover Stop both before and after the seal, repeated seals, stale Agent
  exit and preservation of the new lease.

The preceding release's native conformance, Compaction, parent/child, cancellation
and fault results remain applicable to unchanged runtime source. They are reused
evidence, not newly executed tests in this turn.

## Coverage and verification

| Workspace or boundary | Review focus and evidence |
| --- | --- |
| control-plane | Admission/replay, Stop/recovery, uploads, ordered queue, history/Fork/delete, source-control coordination; new browser and deep-page probes, existing recovery contracts |
| runtime-core | Ingress/seals, leases, native projection, dispatch, control Outbox, SSE/retention; new RF3 scheduling/replay probe and existing PG/fault evidence |
| event-log | Native callback/lock/transaction ownership, assignment, replay and boot-scoped replies; R07R2-02 and real RF3 probe |
| sandbox-supervisor | Pinned Harness/Models/Tools, grant binding, Compaction, settlement/events; native source comparison and unchanged contract suite |
| supervisor-host | Worker capacity/claims, model permits, routing and Runner composition; existing recovery/permit contracts |
| pi-session-postgres | Public Storage overlay/uncertainty, native index/log, Fork batches, cold context and image references; conformance and existing PG contracts |
| subagent-control | Frozen child anchor, preparation outside admission transactions, parent authority, wait/message/cancel; existing RF3 and five live Subagent scenarios |
| sandbox-control | Memory binding view, control closure, allocation/retirement, exact physical observations, shared Volume locks; new crash and native restore probes |
| tool-sandbox | Native file Tools, Bash cancellation, image normalization/input and bounds; R07R2-03 plus existing guest contracts |
| workspace-runtime | Upload staging, hash/fsync/link and persistent bytes; R07R2-01 |
| session-attachments | Claim renewal, immutable source, packing/unpacking, reference reachability/reaping; existing storage and live image recovery evidence |
| cube-completion | Reply identity, claim-check images, separate lossy progress and frame bounds; existing adapter/frame tests |
| cube-api-authorizer | Fixed private management endpoint authorization and tenant/runtime boundary; unchanged contract suite |
| cube-egress-gateway | Configuration refresh, destination policy, CONNECT lifetime; unchanged contract suite |
| provider-egress-relay | Provider routes, proxy lifetime, redacted audit; unchanged contract suite |
| ssh-gateway | Ticket scope/consumption, channel lifecycle and backpressure; unchanged contract suite |
| database | Schema 182 indexes, transaction retry limits, notification-as-hint; new isolated PostgreSQL query probe and existing schema/connection tests |
| domain | Run/Turn/Session transitions and intentional unlimited product quotas; unchanged contract suite |
| protocol | Owned public schemas, execution identities, complete Tool intents, cancellation/image/size contracts; unchanged schema tests |
| observability | Disposable probes, physical health distinction, bounded timing and payload policy; existing metrics/health contracts |
| web-ui | Send/Steer identities, upload scope, queue return, monotonic views, navigation; new real-DOM combination and existing full browser acceptance |
| fake-model-server | Test-only role and deterministic streaming/failure fixtures; unchanged test baseline, no claims about paid provider behavior |
| Cube/deploy/scripts | Pinned upstream/patch manifest, template restore/cleanup, Helm expected state, guest provenance and version matching; owned restore probes and matched release evidence |
| docs/history | Current architecture/ADRs/README, repair/release records and design rationale; backlog/index updated with this review |

New checks and bounded measurements:

- Documentation, formatting, whitespace and new report/reproduction-link checks
  pass. Owned Kafka/PostgreSQL fixtures are removed; the final read-only production
  check retains schema 182, two ready Workers and zero Sessions/Runs/unsealed Runs.
- Four portable defect characterizations pass by reproducing their documented
  failures: cross-action browser identity, upload SIGKILL, partition lock coupling
  and EXIF orientation. These are not assertions that the defects are repaired.
- Real isolated RF3 Kafka: another partition continues during a held handoff;
  same-partition work waits; replacement/rewind leaves exactly one Tool handoff.
  The handler is controlled test code, not a real Cube/PG end-to-end fault.
- Deep pages in **5,000 Sessions / 65,839 Turns**, with 1,000-Turn outliers and
  empty/light histories: starts at 0, 2,400 and 4,800; each query visits 101 Session
  headers, returns the correct 100 visible rows/counts and counts only the page's
  history. Local single-query samples were approximately 0.8–1.1 ms. EXPLAIN
  per-loop row rounding is recorded in JSON; exact result counts are asserted.
- Two owned native Cube template restores, starter and standard, complete with
  successful guest clock reads. Creation plus command took approximately 638 ms
  and 919 ms. Both allocation closures confirmed absence; their owned Volume was
  deleted through the normal managed protocol. No host reboot or model call was
  performed.

Reused checks at the same application source are explicitly linked:
[source repairs](review-repair-20261007.md) — all 22 workspace typechecks,
**1,630 workspace tests + 44 helper tests**, build/browser/install/Helm gates;
[fault report](review-repair-20261007-faults.md) — **210 deterministic cases**;
[matched release](review-release-20261007.md) — live Luna/Cube Tools,
large browser uploads, immutable images, cold Worker recovery and actual image
evidence. The default suite's nine opt-in skips remain visible; earlier separate
RF3 results and live acceptance are not relabeled as a new complete suite run.

The [JSON evidence](repository-review-20261007-r2.json) contains baseline,
findings, probe results/plans, reuse provenance and final checks.
[Portable commands](../../scripts/experiments/review-20261007-r2/README.md)
use owned fixtures. No product code, production schema or running release was
changed by this review. Root README's current topology remains accurate; only
the documentation index, roadmap and unfinished backlog require review links.

## Remaining limits

The earlier host-restart/template-restore `SetGuestDateTime` failure was **not
reproduced and is not declared fixed**. The pinned CubeShim uses a three-second
context for that reset RPC; it is a relative timeout, not a stale absolute
deadline inherited from VM creation. A cold host/storage reproduction with
correlated host, Cubelet, shim and guest timestamps is still required before
changing retry or timeout policy. Successful warm restores and deletion of old
test records do not establish that root cause.

Long-duration mixed fleet/upload load, real physical node failure, PG failover,
bare-host installation and image vulnerability rescans were not repeated here.
Sustained deletion fairness uses the existing bounded lock/admission contracts;
this review's SIGKILL and prior live concurrency probes are not a long soak test.
Missing probes or master inventory never become deletion/quota-release evidence.
The test installation is single-node; RF3 containers do not establish multi-host
availability or exactly-once arbitrary shell effects.
