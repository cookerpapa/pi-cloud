# Native text presentation, 2026-10-12

Status: implementation and focused checks complete; full verification and matched
rollout are in progress. The previously deployed runtime is `native-live-1370d871`.

## Change

[ADR-0245](../adr/0245-native-commit-text-presentation.md) keeps complete Pi Storage
batches unchanged. Runner prepares text descriptions before their existing Kafka
ACK; Projector resolves them using the same native batch/current materialization.
The standalone assistant-text producer and its second text cache are removed.

Run display sequence, native sequence and Kafka offset retain their distinct
meanings. The shared owner serializes native and ordinary publications. Entry
projection commits display coverage atomically; covered replay references are
skipped before fetching a current native value. Each child Run gets its own
boundary even when another Run anchors the publication. The SSE/client protocol
settles active text to its canonical Entry identity before a recovered Task starts
another response. Later non-text coverage cannot hide a newer partial.

PG streaming-body/checkpoint retention remains ADR-0244. No alternate text store,
extra text lookup, Pi Harness in Control Plane or second execution authority is
added. Schema 187 is a drained-cutover guard; private execution transport is v15.

## Verification

Focused tests cover append, replace/truncation/deletion, phase-only updates,
Unicode, canonical completion, same-Task recovery with repeated timestamps,
parent/child routing, delayed publication ACK ordering, PG cold replay, real native
Storage contracts, Stop/input queues, partial Tool filtering and frontend merge.
Whole-workspace type checking, source build, runtime policy and documentation
checks pass. The real Kafka transport suite passes (7 tests), acceptance helpers
pass (64), Supervisor Host passes (93), and focused protocol/text/frontend checks
pass (33). Native owner/PG replay checks pass (2); native storage/recovery
contracts also pass (73). The full fault suite passes all 247 cases. Full-workspace tests and a final
control-plane rerun are still running; live acceptance remains a rollout gate.

The reproducible serialization experiment is
`scripts/experiments/native-text-20261012/measure.ts`. For 100 UTF-8 chunks plus a
final Assistant Entry, with byte-identical native batches:

| | Before | After |
| --- | ---: | ---: |
| Kafka records for this text workload | 201 | 101 |
| Serialized bytes, before Kafka compression | 604,793 | 452,702 |

It removes 100 additional publications and 152,091 bytes (25.15%) in that fixture.
This is an isolated wire comparison, not production throughput or a claim that
Pi never repeats text in its own live state and final Entry. Common non-text
traffic is excluded from both sides.

## Release

Pending maintained matched prepare/apply, GPT-6 Luna native/input/recovery,
browser/image and multi-Conversation acceptance, and owned fixture cleanup.
