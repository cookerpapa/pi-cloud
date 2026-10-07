# Architecture value, evidence and a stopping point

Reviewed `4a27d28c50ef40c1f7fda484a499c2cb292fb27b`. The deployed application is
`review-release-49e9b8cc`, with Pi Durable 1.0.0 and Tool Worker protocol 4.
This review asks whether the complexity earns its place, whether the owner can
reason about and operate it independently, and what evidence is sufficient to
move from repeated architectural review to actual use.

**Judgment:** retain the core architecture and begin a bounded private pilot.
It is already a substantive infrastructure implementation with demonstrated
failure contracts. Its largest remaining gaps for that purpose are repeatable
operation, a consistent explanation of current semantics, and evidence from
ordinary use. Fleet-scale maturity and durable asset recovery after host/storage
loss remain separate, unproved claims. Another broad rewrite is not justified
by the evidence reviewed here.

## Scope and method

The review covers the boundaries of all 22 workspaces; native Harness, Storage
and fixed Tool adapters; admission/publication/projection/dispatch/recovery;
Workspace and attachment ownership; deployment and revision-scoped evaluations.
It is not a new line-by-line audit of historical migrations. The
[evidence inventory](architecture-evidence-review-20261007.json) records source
provenance and limits. No application code, running service or data was changed.

The declared runtime package graph has 62 internal edges and no cycles. The
image-closure gate freshly passes: Control Plane does not depend on the concrete
Runner, and the Runner does not depend on the PG storage adapter. These are
useful structural boundaries, not proof that all semantic coupling is absent.

Thirty-eight targeted tests in five files freshly pass: ordered effects,
Projector handoffs, incomplete Tool-call publication, native cancellation and
Compaction recovery. Image closure and runtime-policy checks also pass. These
are contract tests with controlled dependencies; they are not new live faults
or capacity measurements. The recent [matched release](review-release-20261007-r3.md)
supplies the separately identified real browser, RF3, Cube and Luna evidence.

## What the existing design can explain

| Mechanism | Concrete reason and evidence | Cost or boundary | Judgment |
| --- | --- | --- | --- |
| Native Pi Harness with cloud ports | `DurableAgentSession.open` constructs the public Harness; Pi owns generation, Tool tasks, retry, abort and Compaction. Cloud grants enter the Models/Tool ports. Native Storage conformance and recovery tests exercise the boundary. | The adapter still understands pinned task/checkpoint and record schemas. Public APIs reduce coupling; they do not eliminate upgrade work. User extensions and automatic background Compaction are deliberately outside the present lifetime. | Retain. This is an actual embedded runtime, with explicit product restrictions. |
| PG Run queue, physical-Session lease and fencing | Native pending tasks describe progress; PG decides who may execute them. Worker replacement needs both ordered old-owner closure and a new grant. | Product Runs and native Tasks are two different lifetimes that must be explained consistently. | Retain. Removing the authority boundary would remove a recovery guarantee. |
| Kafka ingress plus one Session Projector group | One acknowledged order carries native commits, Tool intent, controls and seals. Installed views eliminate demonstrated hot routing/publication reads. | Another durability boundary, transactional ownership, projection lag and partition-level waits; it does not eliminate PG materialization. Current evidence does not prove fleet-scale economic necessity. | A defensible chosen investment. Keep the implemented contract; measure a named workload before expanding or replacing it. |
| Commit before external-effect dispatch | `SessionProjector` projects intent, confirms dispatch position, then hands the Tool to Cube. Replay tests prove committed commands are not reissued. | Crash after the dispatch commit but before confirmed takeover can leave an unknown outcome. No arbitrary-shell exactly-once guarantee follows. | Retain the guard and explain the uncertainty. Deleting it would trade a visible uncertainty for possible duplicate effects. |
| Cube KVM, accepted execution lifetime and persistent Volume | Execution is isolated from the trusted Runner. Accepted Tools and files have lifetimes independent of the request connection and Worker. Actual VM/isolation/cancellation/Volume tests pass. | Six maintained patches touch 80 paths. Added diff lines include generated protobufs and tests; patch size alone is not a design verdict. Allocation, node evidence, completion and Volume-reference recovery are owned protocols. | Retain the safety boundaries; budget this as maintained infrastructure, not a small forwarding wrapper. |
| Immutable image attachments alongside mutable Workspace files | A resumed conversation can still see the original image after its Workspace copy changes. Real image/cold-Worker evidence exists. | Another storage dependency, reference lifetime and coordinated recovery requirement. | Justified by the owner's preference to preserve conversation assets independently of Workspace bytes. |
| K3s service discovery | Cube already used K3s. Moving the remaining runtime removed the concrete Docker-IP/EndpointSlice ownership problem. | Local PVs and multiple processes on one host do not provide independent-node HA. | Retain. Adding a second cluster or discovery layer has no demonstrated need. |
| Complete acknowledged document overlay | The adapter already owns a full base and suffix; rereading revisions adds no information in that case. The held-projection probe drops 20 revision SELECTs to zero. | Long local tails consume more reconstruction CPU than a PG-derived checkpoint. Cold/historical reads and eviction still need PG. | A good bounded optimization, with measured tradeoffs rather than a claim that all SQL is unnecessary. |

Source anchors: [Harness adapter](../../packages/sandbox-supervisor/src/durable/agent-session.ts),
[Tool bridge](../../packages/sandbox-supervisor/src/durable/remote-tools.ts),
[native intent interpretation](../../packages/protocol/src/durable-session.ts),
[Storage adapter](../../packages/pi-session-postgres/src/durable/published-storage.ts),
[Projector](../../packages/runtime-core/src/session-projector.ts),
[dispatch](../../packages/sandbox-control/src/tool-command-dispatcher.ts), and
[Cube patch manifest](../../deploy/cubesandbox/runtime-build.json).

The code supports a more precise statement than “high cohesion, low coupling”:
the important authorities are separated, while some failure domains are shared
on purpose. One physical Session writer couples its Lanes; a blocked projection
or bounded takeover delays its partition. Native Pi schema changes require adapter
verification, and Tool transport changes require matched guest/Worker/completion
artifacts. A package diagram without cycles cannot remove these relationships.

## Findings that matter to independent judgment

### D07-01: successful operation still contains knowledge outside the maintained workflow

The repository has real installers, Helm renderers, provenance checks and live
scripts. Nevertheless the latest matched upgrade required separate native-image,
application and guest phases plus temporary operator acceptance/cleanup scripts.
The release record also documents proxy-download recovery, source-archive mode
handling, and an explicit configuration restore after an operator wrapper sent
an unsupported empty URL. The latest real Stop/return/Read report records a
script hash, but that specific live driver remains outside the repository.

This review independently reproduced one narrow failure without changing the
checkout or deployment: `guestBuildIdentityAtRevision` matches current guest
identity under `umask 022`, and yields a different identity under `077`. It extracts
with the caller's permissions and hashes file modes. This is an operator-facing
false mismatch for this unchanged source/image, not evidence of an incorrect
running guest. The original provenance assertion correctly remained enforced.

`production:deploy` explicitly does not rebuild the Cube host protocol; the
deployment guide documents a separate path. Thus this is not a claim that no
upgrade procedure exists. The gap is that another operator cannot yet reproduce
the whole demonstrated release, including its new live checks and cleanup, using
one maintained, bounded procedure without recovering additional context.

**Highest-return implementation slice:** make the existing matched upgrade and
its owned acceptance reproducible from the repository. Preflight the three artifact
identities, build/scan before the disruptive part where possible, make drain and
configuration restoration explicit, and verify that a failed preflight leaves
the serving release intact. Reuse the existing scripts/Helm; this needs no new
workflow service or authority. A fresh-machine installer run remains an honest,
separate open acceptance item.

Evidence: [release corrections](review-release-20261007-r3.md),
[entry point](../../scripts/run-production-deploy.mjs),
[upgrade guide](../PRODUCTION_DEPLOYMENT.md), and
[archive reconstruction](../../scripts/lib/guest-build-identity.mjs).

### D07-02: the maintained decision set gives contradictory answers to basic questions

These are concrete documentation inconsistencies, not a runtime regression:

- ADR-0209 still says another execution needs a new Run. ADR-0229 and current
  code instead retain the logical Run through authorized Worker recovery.
- ADR-0219 directs readers to ADR-0220 and describes Stop as detaching without
  terminating accepted processes. Current Stop uses native abort and ordered
  operation cancellation; ADR-0221 and then ADR-0229 amended that policy.
- ADR-0161 still describes `SessionStorage`, a direct writer and an unfinished
  operation ledger. Current storage is Durable's public `Storage` port, Workers
  publish through ingress, and there is no independent Tool-operation ledger.

ARCHITECTURE, AGENTS and newer ADRs provide the current answer. A reader still
has to mentally apply several amendments to documents indexed as current
constraints. That contributes directly to repeated questions about what Run,
Stop, recovery and “native” mean.

The bounded correction is to mark the superseded clauses and make the current
contract easy to find in the existing architecture overview. It does not require
another architecture proposal or an additional source of truth for documentation.

Evidence: [ADR-0161](../adr/0161-kafka-native-session-commit.md),
[ADR-0209](../adr/0209-control-plane-publication-and-sandbox-authority.md),
[ADR-0219](../adr/0219-ordered-cube-admission.md), and
[ADR-0229](../adr/0229-native-durable-runtime.md).

### D07-03: the feedback loop measures mechanisms more clearly than the intended use

Current evidence supports concrete correctness claims. It does not settle how
much architecture a small private deployment needs, or whether ordinary users
finish work with acceptable interruption and operator effort.

The current full live gate executes seven Runs and 21 Luna requests. Its pure-chat
admission-to-execution sample is 37 ms and its first durable text is 2,239 ms;
first coding takes about 22.8 seconds over four model requests and three Tools.
These are samples of different boundaries, not p95 latency targets or evidence
that every wait belongs to Kafka/PG.

The named load reports also have narrower scope: the September cold-admission
HTTP benchmark explicitly excludes active Agents; the Kafka producer benchmark
excludes Projector, PG, models and Cube; the current native-format PG smoke fixture
uses 24 one-KiB records. The multi-tenant model-load report is from the older runtime
and names RunAttempts and the retired Pro model. Its historical evidence remains
useful, and the evaluation guide already labels revision limits. It cannot certify
the current Durable fleet's capacity.

The 389-line roadmap currently has 81 checked items and only two unchecked ones:
fresh-machine installation and three-physical-node validation. The backlog has
32 open items. Neither gives a bounded private-use graduation criterion. Keeping
enterprise expansion separate from a private pilot would give the owner a way
to finish a phase without finishing every infrastructure investigation.

Use a small, explicitly proposed pilot: one ordinary workweek, roughly 10–20
representative tasks across coding, preview/image iteration and resumed work.
Record usable outcomes, every infrastructure-caused intervention, and latency by
existing stages; keep model mistakes separate from infrastructure failures. These
numbers bound an experiment, not a capacity guarantee. Choose acceptance thresholds
before the pilot. Stop broad architecture work when those agreed conditions hold;
open further work for a demonstrated failure or an explicit new capability.

### D07-04: process recovery and preservation of valuable assets need different evidence

The current read-only deployment snapshot has one node, 26 declared workloads
and 28 running Pods in the Cube namespace. This includes upstream Cube and ordinary
infrastructure, not 26 custom application services. PG, the RF3 brokers, image
storage and local Workspace bytes still share this host's failure domain.

The real Worker/VM tests establish useful continuity, including a new VM attaching
the same existing Volume. They do not show recovery after loss of the host/storage
that holds both PG and Kafka, or after loss of the image store. The backlog already
records coordinated backup/restore as unverified. Repeated owner-approved clean
resets establish that deployment can start empty; they are not retention tests.

This matters particularly because the owner identifies conversations as the most
important asset. Development use with disposable data can proceed under its stated
policy. Before promising preservation of valuable history, define the loss window
and demonstrate a coherent restore/export boundary, including immutable attachments
and any accepted prefix still only in Kafka. A drained, fully projected export is
a smaller first target than multi-node HA. Never restore an old execution grant or
replay unsafe Tools merely to make a restoration test pass.

## A phase can now have an end

| Intended use | Current judgment | Evidence still required for the next claim |
| --- | --- | --- |
| Engineering demonstration / portfolio discussion | Ready to demonstrate actual mechanisms and failures | Explain the explicit tradeoffs; do not substitute line counts or test totals for the demonstrated behavior. |
| Small private pilot with disposable development data | Ready for a bounded pilot under the known limits | Independent reproduction of the operating procedure and ordinary-use feedback. No fleet redesign is a prerequisite. |
| Entrusting valuable long-lived conversations | Recovery evidence remains incomplete | Agreed loss window and exercised restore of history/attachments; file recovery according to the stated Workspace promise. |
| Generally delivered or fleet-scale managed service | Not established by current evidence | Fresh-machine handoff, representative sustained load, independent-node/failover/operations evidence for the promises actually offered. |

One proposed next cycle is enough: reconcile the few contradictory core statements,
make one matched release/acceptance reproducible, then run the bounded private pilot.
Keep the native Harness, PG ownership, ordered publication, external-effect fences,
Volume closure and image references intact. Freeze new infrastructure and peripheral
feature expansion until usage or a measured bottleneck supplies a reason. Asset
restore becomes a gate when the pilot starts keeping irreplaceable data.

For a practical owner explanation, these six answers should be short and stable:

1. HTTP acceptance proves the input/Run was saved, not that the model or Tool ran.
2. Kafka ACK proves publication durability under its stated topology, not PG
   projection or completion of an external effect.
3. PG grants execution; native Durable supplies the continuation. Pending native
   work alone cannot authorize a replacement Worker.
4. Stop aborts the Agent and requests cancellation of its unfinished Tool operation.
   It does not undo file/network effects, destroy the shared VM, or kill completed
   background launches. Uncommitted late results cannot overwrite native abort.
5. An uncertain shell outcome requires inspection; an infrastructure restart is
   not permission to replay it. A stopped input restored and acknowledged into
   the composer again has the documented browser-local unsent-draft lifetime.
6. Pod/VM recovery preserves data whose storage survives. Whole-host asset
   recovery requires an additional proved data-recovery boundary.

The owner's ability to explain and reproduce these decisions is a useful measure
of ownership of the project. It can be evaluated without asking the same assistant
to declare the whole architecture “good” again. R07R3-04 remains owner-deferred;
this review does not reopen it or authorize any implementation/deployment change.
