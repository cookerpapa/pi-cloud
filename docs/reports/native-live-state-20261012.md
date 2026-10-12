# Native live state: implementation and release

Status: implemented and checked in source under [ADR-0244](../adr/0244-kafka-backed-native-live-state.md).
Schema 186 matched deployment and live acceptance are pending. Schema 185 remains
the serving release until the rollout section below is completed.

## What changed

Pi still commits complete native batches through the existing ingress and RF3
Kafka. The Worker adopts a batch only after that acknowledgement. A native
conversation's `pi.live` body is now materialized in Worker/Projector memory;
its streaming changes no longer enter the PG journal or the generic 64-delta
checkpoint index. PG retains the small native commit headers and state digests.

The existing `pi_durable_current` table holds a complete boundary/handoff
checkpoint and nullable Kafka recovery coordinates. The first uncheckpointed
change installs its reference. Native settlement replaces the checkpoint and
clears the reference atomically with the batch's other facts. Writer closure
requires replay through the native head and commits an exact checkpoint before
admitting replacement. The adapter preserves native version and delta count;
materialization never allocates native sequence or creates an Assistant Entry.

Ordinary Worker buffer flushes retain active live values. Projector replay
reconstructs already-projected updates, including accepted updates from a closed
Run anchor; stored fingerprints and cutoffs separate that operation from new
write/effect admission. Replay references also constrain Kafka deletion across
Conversation/Run boundaries. Missing recovery ranges, incomplete handoff and
changed checkpoint data fail explicitly.

The current-state helper is shared with ADR-0243 input storage. No new table,
queue, broker, lease, consumer group or background task scheduler was introduced.
Tool dispatch/cancellation, native input ownership, image references, model
Compaction and frontend event coverage retain their existing boundaries. The
separate Kafka representation of display text remains a follow-up optimization.

## Verification

| Check | Evidence/status |
| --- | --- |
| All workspace typechecks | Passed across 22 workspaces |
| Workspace tests | Full run: 1,692 passed, one SQL-budget failure, nine existing gated skips; that failure was repaired and its focused regression passed |
| Additional storage verification | Latest full file: 70 passed, including two cases added after the full workspace run; combined workspace coverage is 1,695 passing cases |
| Native state failure cases | Buffer flush, replay gaps, duplicate/changed records, lost ACK poisoning, SQL/checkpoint rollback, JSON edge cases, large Kafka offsets, two interleaved Conversations and exact cold restoration |
| Closure/retention | 13 closure cases, including blocked incomplete handoff and a protected suffix after its Run anchor closed |
| Projector handoff | 15 existing handoff/effect-boundary cases passed |
| Operator helpers/assets | 64 passed, including real PG/image restoration and incomplete-restore safeguards |
| Real PG/Kafka transport | Seven cases passed |
| Deterministic fault evaluation | 247/247 passed, including seven new native live-state cases |
| Release source gates | Format/docs/build, install/runtime policy, Go admission/allocation, Helm, observability and image closure passed |
| Dependency audit | Passed with no remaining reported vulnerabilities |
| Paid live acceptance | Pending matched deployment |

The first full run exposed an extra initialization SELECT. Projector live
bootstrap now shares its existing native-head/current-state query; the original
ten-statement first/next projection expectations pass without raising the budget.
Cold Worker completeness is also checked in its existing native-head query.
Two partial indexes support recovery floors and per-Session pending-state reads.

An initial image-Harness fixture used no synthetic Kafka position and could not
admit live progress. It was updated to exercise the same ordered-position contract.
An added interleaving test initially compared two separately timestamped faux
messages; it now compares the exact original message. Neither fix weakens the
runtime retention/recovery checks.

The initial fault run had 224/240 successful mapped cases because the temporary
baseline archive also contained old tests. Root-level Vitest discovered those
duplicate paths and failed their archived tsconfig lookup while the actual
target assertions passed. The temporary test copies were moved out of the
repository; baseline extraction now documents source-only paths. The complete
rerun, expanded with seven new live cases, passed 247/247. The failure evidence
is retained privately; no evaluator success condition was relaxed.

## Isolated storage measurement

The retained probe is
`scripts/experiments/native-live-20261012/measure.mjs`. It runs against a disposable
official PostgreSQL container, never a production URL. The baseline adapter was
extracted from `72cbe218`; both variants used the same native writes and schema
fixture. The 1,001 updates contain an initial generation state and 1,000 native
string appends, producing 257,000 text bytes.

| During generation | Previous adapter | New adapter |
| --- | ---: | ---: |
| PG live journal bodies | 1,002 | 0 |
| Live journal body bytes | 379,334 | 0 |
| Derived full checkpoints | 15 | 0 |
| Derived checkpoint bytes | 1,978,320 | 0 |
| Current PG baseline bytes | 0 | 197 |
| Native commit headers | 1,002 | 1,002 |
| Counted adapter SQL statements | 6,051 | 4,005 |
| Observed WAL bytes | 2,467,584 | 589,048 |

These are initial isolated samples, not production throughput claims. The probe
excludes Kafka networking, Run authority checks, provider work and driver
BEGIN/COMMIT statements. Other repository checks were running on the host.
Generation-loop time was about 10.2 versus 11.1 seconds; duplicate replay plus
exact cold read was about 5.7 versus 8.4 seconds. Sampled heap peaks were about
59 versus 121 MB, including transient allocations; these are not retained-state
sizes or fleet memory estimates. Reconstructing and checking the complete current
value has a CPU/memory cost. The demonstrated gain is less PG payload/SQL/WAL
work, not a demonstrated improvement in overall latency.

After simulated handoff the new adapter stored one 258,245-byte exact recovery
checkpoint. After normal completion it returned to a 197-byte live baseline;
the final Assistant Entry remained canonical. Both variants restored identical
text and native delta counts. Private JSON reports retain all measurements.

## Deployment and live acceptance

Pending. Use the maintained matched release, including complete writer draining
and positive native VM absence. No old-reader compatibility mode is retained.
The pre-release observation found no business Runs/Sessions/Workspaces/native
commits or active VM/writer/terminal resources, so no existing business data
needs removal for this migration. Existing account/configuration fingerprints
and stable credential-field fingerprints were captured privately.

The maintained native-input acceptance driver now also exercises visible text
with no PG live bodies, Stop preservation, and loss of both Worker and Projector
memory. It requires actual kubelet failure evidence and same-Run recovery,
then uses the existing owned fixture cleanup. GPT-6 Luna remains the paid model.

The rollout record must include the matched source/image identity, schema,
live outcomes, fixture cleanup, final readiness and preserved configuration.
