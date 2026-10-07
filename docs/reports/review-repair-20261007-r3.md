# October 7 recovery, input and Read repairs

Approved scope: R07R3-01/02/03, O07R3-01 and the two cleanup candidates from the
[review](repository-review-20261007-r3.md). R07R3-04 (CubeMaster configuration
logging) is explicitly deferred by the owner for this private deployment.
Implementation starts from `21c082b4`; [ADR-0236](../adr/0236-recovery-input-identity-and-tool-diagnostics.md)
records the public/guest contracts before implementation.

## Behavior

- **Recovery:** cancelled queue inputs that never obtained a lease or started
  no longer block recovery after the active Agent's exit and output seal are
  confirmed. A later actual admission still supersedes older proof. Real PG
  cases combine withdrawn input, individually removed input, held Steer and
  retained uploads in both proof orders. Missing exit, wrong tenant/lease and
  stale proof after a later failed execution still cannot admit new work.
- **Returned input:** the API reads the original acceptance key from the existing
  Run. Successful composer restoration retires only that Session/key's unresolved
  browser submission. Resending the returned text and image creates a new Run.
  An older return or ACK cannot discard a newer unresolved submission's key;
  uncertain retries keep their identity. Draft edits and return acknowledgements
  retain their existing behavior. No new queue, receipt table or text deduplication.
- **Read:** an oversized line returns a UTF-8-safe prefix of actual file content,
  including native BOM semantics, with Pi-compatible byte continuation diagnostics.
  Ordinary ranged reads also separate offset guidance from content. Fixed Tool
  diagnostics survive completion encoding, Worker processing and native Harness
  output bounds into the final model context. Bounded reading remains at the guest;
  it does not read the entire suffix just to reproduce native total-file counts.
  Image support and file/mutation limits remain unchanged.
- **Document reads:** an acknowledged local base plus its complete suffix no
  longer performs revision SQL. Missing bases, older historical points and flushed
  overlays still use PG/checkpoints. Native versions and delta counts are unchanged.
  There is no new cached materialized document or checkpoint authority.

The unused Pi 0.84 stream-error classifier is removed. README now has one current
release/source-status pointer; historical evidence stays in the documentation map.
Native retry policy and the separately observed upstream HTTP-status classification
limitation are unchanged. No native Cube configuration/logging patch was modified.

## Verification and measurement

`npm run check` passes all **22 workspace typechecks**, **1,666 workspace tests**
and **45 acceptance-helper tests**. Focused real-PG, guest/native parity and
Harness regressions pass. The default suite skips nine opt-in integration cases:
the seven Kafka/PG cases pass separately, while the two live Cube VM cases remain
part of matched deployment acceptance.

The 7 RF3/PG integration tests, browser presentation gate, production frontend
build, four guest bundle entry points, Helm/runtime-policy/image-closure checks
and dependency audit pass. Documentation, formatting and diff checks pass.
[Bounded measurements](review-repair-20261007-r3.json) separate fixture results
from production acceptance.

[Fault evidence](review-repair-20261007-r3-faults.json) confirms 226 cases.
The initial sweep passed 223; three new recovery cases were not selected because
Vitest quoted the `$order` test-title field. Changing the title formatter to `%s`
made it match the manifest; an explicit real-PG rerun passed all three assertions.
The report retains that initial selection failure and the rerun evidence, rather
than treating a missing/skipped test as passing. No product assertion was relaxed.

The original held-projection probe now records **0 revision SQL queries for 20
document reads**, versus 20 before repair. It still returns correct values, and
an unavailable cold revision read no longer fails a complete local read. This
does not make Worker admission or leases independent of PostgreSQL.

The additional cost probe uses a synthetic 16 KiB document and 20/130/1,024
deltas, comparing local reconstruction with the existing PG checkpoints. Long
local tails use more CPU than a derived checkpoint; they avoid the SQL round
trip and remain bounded by the existing overlay eviction budgets. Measurements
are process/fixture observations, not a capacity or production-latency promise.

| Deltas | Local revision SQL / 40 reads | Cold revision SQL / 40 reads | Local wall ms / 40 reads | Cold wall ms / 40 reads |
| --- | ---: | ---: | ---: | ---: |
| 20 | 0 | 40 | 15.914 | 107.281 |
| 130 | 0 | 40 | 14.400 | 72.431 |
| 1,024 | 0 | 40 | 53.827 | 71.915 |

For 1,024 deltas, 200 pure materializations used about 151 ms process CPU from
the local suffix versus 0.42 ms from the PG-derived checkpoint; local document
reads still avoided the round trips in this sample. The existing overlay's
2,048-write / 16 MiB eviction bounds are retained, and cold reads still use the
64-delta derived checkpoints. No additional materialized cache was introduced.

## Release boundary

The subsequent [matched rollout](review-release-20261007-r3.md) is now complete.
The source-verification boundary below records the state before that deployment.

**Source repair only; not deployed.** Tool Worker protocol becomes **4** and
returned-input items require `idempotencyKey`. API, browser, Worker, completion
adapter and guest must be built/deployed together. Protocol 3 guest outputs are
rejected; no compatibility branch is retained. Cube management protocol 7,
guest input protocol 4, PG schema 182 and Pi Durable/AI/Chord 1.0.0 remain pinned.

The running release remains `review-release-ad2bdd97`, documented in the
[previous rollout](review-release-20261007-r2.md). This task did not reset user
data, restart production, consume model tokens or claim new live acceptance.
The passing [review-time live gate](repository-review-live-20261007-r3.json)
belongs to that earlier deployed source, not this repair.
