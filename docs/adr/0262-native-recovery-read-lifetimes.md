# ADR-0262: Native recovery read lifetimes and child reattachment

Status: deployed as `native-recovery-8c00826a`, schema 191, 2026-10-19.

The owner approved the [Worker/Harness recovery repairs](../reports/worker-harness-recovery-repair-plan-20261019.md).
The [review and isolated timing](../reports/worker-harness-recovery-review-20261019.md)
show unbounded Worker reads, discarded cancellation, missing Submission status
indexing and unnecessary per-child source lookups. This decision changes read
lifetimes and recovery admission, not the native history or execution authority.

## Decision

- Reuse the existing Kysely/node-postgres adapter and Pi public Storage Context.
  Workers own a separate four-connection direct-PG read pool with a 30-second
  acquisition/query budget. A budget applies to an individual database operation,
  not the duration of an Agent or the size of its family. Claim/lease/publication
  and attachment inventory mutations keep their existing authority paths.
- A scoped read signal reaches pool acquisition, the checked-out read connection
  and attachment hydration. Cancellation evicts an in-flight read connection;
  a cancelled acquisition never executes SQL if a connection arrives later.
  Queue cancellation and owner retirement cannot leave reads executing without
  an owner. The adapter must retain named-query reuse and independent write pools.
  Start lease observation before reading the cold native head, so revocation can
  cancel that read too. Before an open handle exists, preserve known ownership/
  transient failure classifications; cleanup must not reclassify an incomplete
  or corrupt checkpoint as a recoverable lease loss.
- Native read Context cancellation applies to reads only. Acknowledged commits
  are still adopted, and User Stop retains the reads/writes needed for native
  abort and input withdrawal. Startup lifetime follows Worker/Session ownership;
  User Stop blocks effects and settles through Pi, including Stop-on-resume.
- Known transient data-read failures interrupt the owner with
  `native_storage_unavailable`. RunExecutor uses the existing ordered Session
  closure and same-Run re-admission. A short delay in the existing `available_at`
  field prevents rapid retries; no new queue or retry counter is introduced.
  Corrupt/missing records and integrity mismatches remain explicit failures.
  Uncertain writers never reinitialize themselves, and unavailable PG/Kafka
  cannot be treated as successful closure.
- Give queued/placed native Submission scans a matching status/ID index, valid
  for actual named and generic plans. Keep completed receipts and current-value
  semantics. No additional native state table or checkpoint is introduced.
- Separate reattachment of an existing native child from initial input admission.
  Restore native configuration/Submission identity, rebind cloud ports and batch
  remaining child view/cursor reads. Do not reload/copy the original prompt solely
  to satisfy the initial-start path. Missing initial-admission windows must retain
  the existing durable control delivery semantics. Keep the family effects barrier.
  A restored child uses the explicit private execution-envelope input
  `{ kind: "resume" }`; it has no prompt body and cannot create a Submission.
  PG root queue admission still accepts prompt input. Matched Worker code validates
  the child view, existing native receipt and persisted agent configuration.
- Image byte reuse is conditional on a demonstrable public operation boundary.
  Until that boundary is established, preserve ADR-0192's per-decode validation.
  No TTL heuristic, global byte cache, private Pi patch or incomplete Storage
  record is permitted. Cancellation propagation is required independently of reuse.

Pinned Pi 1.0's `GenerationTask.request` builds `runtime.context()` before
`beforeRequest`; `CompactionTask.select` also builds it before `beforeCompact`,
and recovered summarize phases build context without that hook. The public
registry does not replace built-in tasks. Those hooks therefore do not establish
the required encompassing decode lifetime. This slice retains per-decode reuse
and validation rather than introducing a cache with a guessed lifetime.

## Adopt versus build

Use the already-pinned node-postgres Pool/client, Kysely dialect and native Pi
Context rather than a new pool implementation, scheduler or storage framework.
The maintained database adapter already owns connection eviction, read/checkout
budgets and named plans; cancellation belongs at that existing boundary. Existing
Session closure, PG Run queue and native task recovery provide continuation. The
change adds no independently authoritative workflow or storage protocol.

The read pool enables PostgreSQL's
[client connection checks](https://www.postgresql.org/docs/17/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL)
at one-second intervals on the supported Linux deployment. This lets PG stop a
running read after local socket eviction; `statement_timeout` remains the bound
when a network fault prevents prompt disconnect detection. Socket eviction alone
did not pass the server-termination test. This uses PG's existing facility instead
of adding a cancellation pool or depending on node-postgres private query state.

## Acceptance and delivery

Cover pool saturation, cancelled queued/locked reads, connection loss, image
metadata/body cancellation, partial Harness initialization, Stop settlement,
acknowledged commit adoption and ordinary pool reuse. Verify same-Run recovery
after ordered closure, delayed retry, and explicit corrupt-state failure.
Exercise active families, initial admission gaps, pending input and unsafe Tool
non-replay. Record actual prepared query plans and 1/8/32/128-child measurements.

Required source/artifact checks precede a drained matched application/schema
release and relevant live acceptance. Preserve accounts/configuration/credentials,
confirm physical fixture cleanup and retain failed upstream samples separately.
[Delivery evidence](../reports/worker-harness-recovery-repair-20261019.md) records
the deployed source, checks and bounded measurements. Native/child recovery,
Control Plane outage, unchanged large-image cold recall and full Cube acceptance
pass; physical cleanup and original configuration preservation are confirmed.
