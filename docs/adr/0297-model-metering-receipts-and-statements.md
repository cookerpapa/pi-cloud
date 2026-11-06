# ADR-0297: Model metering receipts and priced statements

Status: accepted and implemented; [delivery and verification](../reports/model-accounting-20261106.md).
Date: 2026-11-06. Tracking: [Issue #4](https://github.com/cookerpapa/pi-cloud/issues/4).

## Ownership and scope

PiCloud PostgreSQL owns attributable model-usage facts, rate versions and priced
statements. Pi continues to own model execution, retries, context and native usage.
Neither the financial records nor a usage receiver may schedule/replay a model or
Tool. `/usage` retains its native-history/context meaning. Sandbox/storage billing,
wallet enforcement, payment collection and automatic top-up are outside this slice.

Every cloud model HTTP request carries a bounded PiCloud context from the trusted
Worker Model Gateway or control-tool caller: an invocation UUID, tenant, public
Session, physical Session/Conversation where available, Run, requested provider,
model and purpose. It is distinct from the reusable transport key. A new Run uses
new attribution even when it reuses an upstream connection. A logical invocation
can contain several actual provider attempts; CPA's execution UUID identifies each
reported usage record. Context is copied before request cleanup, never recovered
from a pooled Gin request or guessed from a shared client API key.

## Adopt-before-build decision

Reuse the fixed CPA v8 usage reporter's normalized categories and execution IDs.
Its asynchronous usage plugins, request-completion hooks and Management API queue
do not durably hand off a record before process loss. CPA Usage Keeper and
cliproxy-costs preserve received observations but do not close that source window.
Lago and OpenMeter provide downstream ingestion/pricing; neither can reconstruct
a source event that was never delivered, and their full deployment would add
authorities/dependencies beyond this initial model-only statement requirement.

Use the existing, pinned bbolt dependency (`go.etcd.io/bbolt v1.5.0`, MIT) for a
small provider-local receipt/outbox adapter. CPA already uses this implementation
for local KV state; the public KV facade lacks the transactional enumeration needed
for this outbox. A separate file on the existing provider data volume avoids
coupling receipts to a disposable cache or a change of OAuth directory. No new
database service, broker, workflow engine or model scheduler is introduced.

The evaluated MIT-licensed alternatives are fixed at
[Keeper `aa687529`](https://github.com/Willxup/cpa-usage-keeper/tree/aa687529e392833e17ad0eb7ccfc4dec8eda0982)
and [cliproxy-costs `abbca52e`](https://github.com/MelonSmasher/cliproxy-costs/tree/abbca52e089c00f1f5b87864bdbca88537b2f262).
Keeper stores received usage for a dashboard; the cost plugin provides estimates,
not a wallet or source admission journal. Both still depend on source delivery.
Their persistence is useful downstream but cannot make CPA's pre-callback memory
queue crash-durable. Replacing that bounded capture gap, rather than copying their
reporting UI or adding another database service, is the reason for this adapter.

The journal is a delivery buffer, not an independent balance or pricing authority.
Completed deliveries are collected after PostgreSQL acknowledgement. The financial
port is PiCloud-owned; vendor usage objects, credentials, request bodies, responses,
image bytes and error bodies never enter the public schema or journal.

References: [CPA usage](https://github.com/router-for-me/CLIProxyAPI/blob/c2f402b45643f0740d70b9010fd7d8d0aab7ef65/sdk/cliproxy/usage/manager.go),
[bbolt](https://github.com/etcd-io/bbolt),
[Keeper](https://github.com/Willxup/cpa-usage-keeper),
[cost plugin](https://github.com/MelonSmasher/cliproxy-costs),
[Lago](https://github.com/getlago/lago),
[OpenMeter](https://github.com/openmeterio/openmeter).

## Source receipt and delivery

1. Authenticate the existing provider request and copy its validated accounting
   context. Persist an invocation-start receipt before dispatch. If this local
   commit is unavailable, reject before starting new provider work.
2. Add a bounded, optional synchronous SDK capture port for the usage reporter's
   attempt identity and records, before the existing asynchronous plugin queue.
   The PiCloud adapter commits sanitized facts locally. It does not parse streamed
   text to estimate tokens or turn an accounting failure into a model replay.
3. Record request completion independently of usage callbacks. Started attempts
   without a receipt remain visible as missing usage. A restarted provider marks
   interrupted receipts uncertain; it never reissues their model calls. An I/O
   failure after dispatch leaves the admission receipt as recovery evidence and
   blocks unrecordable new admissions until a real local write succeeds again.
4. Deliver bounded batches to an authenticated private Control Plane endpoint,
   reusing the existing provider-service credential. Use stable event identities,
   acknowledge only after PG commit, and retry the same events after lost replies.
   Delivery does not use a cancelled Worker request's signal and does not require
   the original Worker, Run lease or Session writer to remain active.
5. PG rejects conflicting reuse of an event ID and commits same-content duplicates
   without counting twice. Session deletion, Fork and Compaction do not delete or
   duplicate consumption. The recorded financial identifiers are not cascading
   foreign keys into deletable chat history. Tenant ownership still scopes reads.

Outbox capacity is an operational backpressure boundary, not a product quota.
Do not silently discard pending facts to regain space. Receiver downtime permits
execution while the local durable buffer can admit it; source storage loss is a
declared single-host durability limit. No source mechanism can recover tokens the
provider never reported, or a reply lost before capture: those remain unconfirmed
and are not charged as if an estimate were a receipt.

## Pricing

Rates are explicit, immutable versions with an effective time, currency and
decimal unit prices. Start with model token categories; hosted-image/search or
other media dimensions without a supported tariff remain unpriced. Normalize
cache/reasoning subsets once, and do not charge both a total and its subsets.
Distinguish provider-reported consumption, configured customer pricing and any
upstream cost estimate. Use exact decimal/integer arithmetic, not binary floating
point or per-token rounding to cents.

New rates do not rewrite settled historical amounts. Missing rates and incomplete
usage are visible, never silently represented as free usage. Statement queries
and export are initially informational; this change does not collect money or
choose a prepaid/postpaid business model. Actual wallet admission and collection
would require an explicit business policy and its own acceptance.

## Publication and acceptance

The host/provider protocol and additive PG schema are matched; preserve accounts,
configuration, original Workspace bytes and native history. Do not change Cube's
finite elastic retention or use probes as billing/destruction authority. Record
the maintained release scope before cutover rather than bypassing publication
checks or keeping legacy business paths.

The schema 209→210 publication retains the installed Sandbox artifacts. The
Guest's explicit source identity is unchanged. Cubelet's broad protocol directory
would include the new host-only accounting schemas despite not using them. The
matched operator therefore checks the installed artifacts' source revisions: every
existing copied file stays identical; only the two new accounting modules and
their additive index exports are allowed. Changed Tool, completion, native Cube
patches, dependencies or Guest inputs reject this path. The operator builds and
scans all seven host/application images that it will publish, retaining the six original Cube/Guest artifacts and their own evidence.
The zero-fixable-HIGH/CRITICAL gate remains mandatory for every new image. It drains
Runs and all Session writers, and publishes
API/Worker/provider/Web/schema together. It neither reconciles Cube nor registers
a new template. Deployment evidence retains the original Cube/Guest image and
source identities, rather than falsely attributing them to the new host build.
The retained artifact checks allow one explicit new host-only OS patch input
in the Docker allowlist; retained Cube Dockerfiles never copy it. This is a reviewed
accounting-only publication, not a general compatibility mode.

The first full-candidate scan discovered
[APT CVE-2026-109518](https://security-tracker.debian.org/tracker/CVE-2026-109518).
New Debian host images install the fixed APT 2.6.2 before other package changes.
The unchanged Cube/Guest Ubuntu images still need their separate maintenance
update; that finding is retained in the backlog and scan evidence. They are not
relabelled as freshly scanned/patched artifacts. No vulnerability exception is
added to make the new host images pass.
Existing VM allocations and Workspace bytes must be checked before and after it.

Verify correlation on cached connections, native children, compaction and the
control-tool image path; failed attempts; duplicate/conflicting deliveries; crash
before/after local capture and PG commit; receiver outage; source capacity/I/O
failure and recovery; cancellation; missing usage/rates; pricing version boundaries;
and deletion/Fork independence. The operator must be able to demonstrate a priced
owned fixture without assigning invented prices to the owner's real model usage.
