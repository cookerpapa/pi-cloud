# Worker / Harness recovery repair plan

Status: proposed, 2026-10-19. This records the owner's request for a concrete
repair plan; implementation and rollout have not started.
Baseline: `2483e425`. Findings and evidence:
[recovery review](worker-harness-recovery-review-20261019.md).

Keep Pi's public Harness/Storage execution model, the physical Session lease and
writer, PG control authority, ordered Kafka closure and native unsafe-Tool policy.
The work belongs in the existing recovery/read adapters. A change to the private
execution contract or per-decode attachment policy needs a current ADR before
implementation; the plan does not silently authorize a competing scheduler or
checkpoint store.

## 1. Bound and cancel recovery reads — WHR-01 / WHR-02

Use the existing database adapter for a separately owned native-read pool. Cover
connection acquisition, head/record/document reads, child metadata and attachment
inventory reads. Keep claim, lease, publication and other mutation transactions
on their existing authority paths. Attachment inventory writes must not inherit
a disposable-read policy merely because reads share their class.

Choose per-request read budgets and connection counts from the existing adapter
and measured startup behavior. Account for their aggregate connection cost. A
large family may need many bounded reads; a per-query deadline is not a fixed
deadline for recovering every possible family size. Cancellation/expiry must
stop or evict the actual read and release its resources; a rejected Promise with
background SQL still running is insufficient.

Thread native read Context/AbortSignal through host, Storage, projection and image
hydration. Give queued reads and native bootstrap an explicit owner lifetime.
Distinguish three cases:

- Revoked owner or retiring Worker: cancel its reads and dispose partial startup.
- Cancelled read/wait: end that operation without silently converting it to
  successful state or interrupting an acknowledged commit's adoption.
- User Stop: preserve native abort/queue withdrawal and its necessary settlement
  reads. Keep effects gated during Stop-on-resume; do not replace every background
  cleanup Context with the same cancelled turn signal.

Classify failures at the trusted read boundary. A proven transient connection or
read-timeout failure must retire the current local owner and request continuation
through the existing ordered Session closure/re-admission path. Preserve the Run,
Submission and queue identity; grant no successor before durable closure. Do not
automatically reinitialize an uncertain producer. Persistent unavailability must
retain recoverable ownership state without a tight retry loop. Missing native
records, mismatched hashes or corrupt checkpoints fail explicitly rather than
being treated as empty state or endlessly retried. PG/Kafka unavailability is not
proof that closure succeeded. Keep safe diagnostics for the actual failure class.

Acceptance: occupied pools, locked reads, unavailable connections, image reads,
lease revocation and partial startup all release owned resources within their
applicable budgets. Stop before/during bootstrap and while binding children still
settles without new effects. A transient read failure can recover the same Run
after ordered closure; corruption cannot silently continue. Uncertain publication
and acknowledged commits retain their current semantics.

## 2. Index pending Submission reads — WHR-O3

Add or refine the access path for physical-Session Submission scans by status
and ID cursor. The disposable comparison index in the review is evidence for the
direction, not a migration to copy without checking production query plans.
Validate the actual parameterized/named queries, including generic plans; adjust
code-owned enum predicates if needed while keeping content values parameterized.

Preserve completed native receipts and their idempotency behavior. Reuse the
existing record/current-state tables. Check index overlap before choosing the
smallest useful schema change; deploy it through the maintained matched release.

Acceptance: with a fixed pending set and growing completed receipts, examined
rows and database work track the pending set rather than the completed history.
Cover queued/placed, zero results, multiple pages, multiple tenants/Sessions,
status transitions and the actual prepared-statement behavior. Record both SQL
count and examined rows; retain the original failed growth measurement.

## 3. Simplify child restoration and batch metadata — WHR-O1

First separate initial input admission from reattaching an existing native child.
Today the shared start path requires the original prompt and recomposes its
language/system instructions, even when the original Submission already exists
and the final action is native `resume()`.

Use Pi's already-persisted agent configuration, Submission and task state for
restoration where they are sufficient; rebind current cloud model/Tool ports and
authority without resubmitting input. Remove the original-prompt lookup that only
exists to satisfy the initial-start interface. Do not replace that lookup with a
new copy of the prompt in another table/document. Prove the partially initialized
creation/admission windows separately: a truly absent initial Submission and
missing/corrupt restoration state must not be conflated.

Read remaining child display cursors and any genuinely required source metadata
in bounded batches, preserving tenant/root Run/native source identity. Eliminate
one Promise/query pair per child. Maintain the family effects barrier and native
Session serialization. Do not promise that making cloud metadata batched makes
all native task/context restoration a single SQL request. Measure the remaining
per-child binding phase before deciding whether bounded concurrent preparation
helps; preserve dependency and cancellation order.

Acceptance: initial creation, lost creation/admission replies, cold continuation,
parent already answered with live descendants, edited queued input, and Stop
during restoration all retain their native identities and outcomes. No duplicate
delegation or unsafe Tool dispatch occurs. Additional cloud metadata reads grow
with bounded batches instead of the current two-per-child pattern.

## 4. Validate scoped image reuse — WHR-O2

Target repeated hydration of the same immutable reference within one context
assembly/restoration operation. The reuse key must include tenant and complete
reference identity; populate it only after successful integrity validation.
Define explicit byte and lifetime bounds, share only the relevant in-flight/
verified result, and clear it on completion, cancellation, error or owner disposal.
Independent later reads retain the required metadata/integrity semantics.

First prove that the pinned public APIs expose a reliable operation boundary for
bootstrap, generation, Compaction and concurrent children. If they do, record the
narrow refinement of ADR-0192's per-decode policy and implement the bounded reuse.
If they do not, keep the current correct behavior and document that limitation;
do not fake partial Storage records, infer an operation solely from call timing,
patch private Pi fields or introduce a cross-Run byte cache.

Acceptance if adopted: repeated references in the same operation need one blob
read, unrelated operations/tenants do not share incorrectly, changed reference
metadata and integrity failures remain observable, and cancelled/large/concurrent
reads obey the memory/lifetime policy. The earlier provider large-image header
timeouts remain a separate unresolved transport investigation.

## Delivery sequence and verification

Implement read lifetimes/error handling and the indexed status path first, then
child restoration simplification. Image reuse follows its public-API feasibility
check. Keep each source slice complete and covered by regression tests. Replace
or archive the review's defect-characterization assertions once repaired; retain
their original evidence in Git, not compatibility implementations.

Test historical Entries and completed Submission growth separately. Exercise
1/8/32/128 active child views with a fixed historical background, plus queued
input and attachment-size variation. Measure both restoration-to-ready and the
first admitted effect, query/row counts and memory; provider response latency is
a separate measurement. Retain the native conformance, queue/Stop, unsafe Tool,
family, RF3 and ordered-closure tests.

The subsequent [baseline timing](worker-harness-recovery-review-20261019.md#follow-up-active-family-restore-preparation-timing)
measures 1/8/32/128 short-text children reaching the model-permit port in
0.157/0.534/1.758/8.341 seconds. It uses pre-granted authority, a new native host
and synchronous PG publication in place of Kafka, so it is not production
failover timing. The separate 2N cloud metadata lookups are a small fraction of
total SQL; profile sequential native binding before promising improvement from
batching alone. Repair acceptance still needs realistic context/image sizes and
the actual transport boundary.

After required source/artifact checks, use the maintained drained matched release
and relevant native/browser/image/child/Control Plane outage/full Cube acceptance.
Preserve accounts, model/provider configuration and credentials. Confirm owned
physical cleanup before discarding ownership records. Report source, deployment,
passed gates and unresolved external acceptance separately; the previous image
gate is not considered passed merely because this repair is deployed.
