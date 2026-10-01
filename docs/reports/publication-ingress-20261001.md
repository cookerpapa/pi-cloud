# Control-plane publication ingress — 2026-10-01

The first implementation slice of [ADR-0209](../adr/0209-control-plane-publication-and-sandbox-authority.md).
Local implementation and isolated acceptance; no production migration or rollout.
Sandbox lifecycle, Cube execution handoff and independent Broker removal remain
separate pending slices. Session + one execution per Run is unchanged.

## Behavior

Workers install their recorded PG publication grant through private HTTP, then
append through the partition owner selected by the existing Projector group.
Normal appends use installed memory state, without PG queries. The same physical
Session queue carries data and seals. Closure rejects new old-scope submissions
before draining prior accepted records. Kafka transaction commit is the success
receipt; a lost response never causes an automatic semantic retry.

Stable partition transactional IDs and current group metadata fence replaced
publishers. Publication transactions retain the existing dispatch offset under
its commit guard; they never advance or regress Tool dispatch. The read-committed
consumer tracks commit markers and aborted-only tails, commits quiet processed
tails periodically, and retires native producers before their borrowed consumer.

Admission tickets invalidate delayed PG reads only for the affected Session.
Writer-cache and pending-byte/record budgets are process-wide. A PG-projected seal
can resolve a lost seal ACK. Cancellation while opening publication joins startup
cleanup and never launches Pi. No old direct-Worker producer remains as a fallback.

Migration 158 requires drained Runs, released Session leases and completed seal
Outbox publication. The new wire is `pi-cloud.execution-log.v12`, with
`pi-cloud-session-projector-v2`. Existing PG native bodies and Volume bytes are
preserved. New and old publication services must not overlap.

## Isolated evidence

Tests used an owned PostgreSQL 17 instance and three Apache Kafka 4.0.0 nodes on
one host, with RF3/minISR2 transaction and execution logs. No provider calls.
These checks do not establish independent-machine HA or enterprise capacity.

| Check | Observed result |
| --- | --- |
| Private HTTP → real Kafka → PG | Opaque native fields retained; append-handler SQL count **0** |
| Ingress replacement | Cached grant restored only after an explicit pre-enqueue rejection |
| Lost HTTP commit response | One submission; no automatic duplicate publication |
| Old publisher SIGSTOP / replacement / SIGCONT | Replacement commits; resumed old write rejected |
| Committed / aborted transaction tails | Catch-up completes; aborted data never delivered |
| Replay below dispatch boundary | Text rebuilt without repeating committed effects |
| Startup cancellation | No Runner call, no native append, normal Run-local closure |
| Capacity under a private producer quota | 6,000 offered; 66 accepted and persisted; 5,934 rejected before enqueue |
| Partition isolation | 513 held records recovered; another partition progressed in 58.45ms in this sample |
| Retention with transaction offsets | Low watermarks 0 → 5 → 40; PG failure retains 40 |
| Cutover guard | Active Run refuses migration; drained and sealed Runs permit it |

The small warm HTTP-to-RF3-commit sample initially had median 115.98ms and maximum
134.65ms (12 samples). Native callback timing placed most waiting in
`sendOffsetsToTransaction`. Reducing initial producer retry backoff from 100ms to
5ms, retaining its exponential 1,000ms ceiling, reduced a subsequent 12-sample
median to 23.57ms and maximum to 39.22ms. A later combined run measured median
28.34ms and maximum 39.88ms. These are local warm-path observations, not provider
latency or a cross-host service-level guarantee. The producer also resolves its
known topic during startup; first-use metadata/transaction setup remains distinct
from warm append latency.

## Verification

The CI-shaped `npm run check` passed: **1,461 workspace tests + 62 acceptance
helpers**; two external Cube opt-in tests were skipped. Both PostgreSQL URLs and
the isolated three-broker Kafka URL were enabled. The versioned
[108-case fault report](publication-ingress-faults-20261001.json) passed completely.
Formatting, documentation, self-hosted install contracts, Helm, runtime policy,
observability and the existing high-severity security gate also passed.

The maintained CI enables both `PI_CLOUD_POSTGRES_INTEGRATION_URL` and
`PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL`. Earlier invocations lacking these
settings skipped required PG cases or reset PGlite's emulated socket during the
direct Steer capacity test; those runs are not counted as successful regression.
The real PostgreSQL run passed all 295 control-plane tests. No production behavior
was changed to accommodate the emulator, and no required PG case was skipped.

No live user Session, production VM, existing Workspace Volume or deployed image
was changed. Full physical multi-node failover, live provider latency and the
subsequent Cube handoff/shared-VM acceptance are outside this publication slice.
