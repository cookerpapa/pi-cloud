# Single-path shared Fork verification

Implementation: [ADR-0287](../adr/0287-single-path-shared-forks.md), schema 204.
Matched `shared-forks-20261030` is deployed from `f21b5b42` on schema 204,
application Helm revision 125. Source, composed-browser and live acceptance pass.
These measurements do not establish a fleet SLA.

The later [prompt amendment](fork-context-removal-20261030.md) removes the
automatic identity notice described in this release's original behavior below.
Shared history, backend provenance and Agent-family boundaries are unchanged.

## Behavior

A manual Fork keeps the selected Agent's visible path and already returned
results. It creates no old child runtimes, pending inputs or execution grants.
The new runtime receives a native system section explaining its identity and
the historical nature of old Agent IDs. Workspace bytes are not copied.

Native entries and presentation frames share immutable records through balanced
directories. Local commits keep their original Kafka fingerprints. A physical
Session may be retired without deleting referenced history. Current native state
keeps its existing retention policy. A child that receives another input updates
only the source's presentation root; prior Forks keep their original frame range
and header version. Source pruning cannot be undone by a later bootstrap pass.

## Isolated measurements

The maintained service fixture uses real PostgreSQL and the actual Fork service,
then reads the new conversation. It creates no model request, VM or user data.
The complete 1 GiB fixture contains 35,330 entries, including a native compaction
marker; the native Harness reads the inherited context through the real Storage
adapter. Measurements below are individual end-to-end observations, not p95s.

| Check | First Fork | Nested Fork |
| --- | ---: | ---: |
| 1 GiB Fork service | 765 ms | 373 ms |
| Cold chat-history read | 496 ms | 398 ms |
| Cold native context read | 114 ms | 92 ms |
| Model-context bytes | 60,912 | 60,912 |
| Model-context messages | 4 | 4 |

The preceding schema-203 service measurement was 61.7 seconds for its first
1 GiB Fork and 50.1 seconds for a nested Fork. The new native context contains
the latest compaction and retained suffix, not the lifetime transcript.

A separate 8 MiB fixture with an 8 KiB native document completed 1,000 successive
Forks. The final Fork took 848 ms and its cold history read took 251 ms. Native
ancestor definitions and small state still have a measurable cost; this is not
a claim of constant work for unlimited native metadata.

Ordinary source projection now captures display descriptors once, instead of
reconstructing/copying them for every Fork. After eliminating duplicate record
updates, a 200-sample comparison against commit `663cd147` measured:

| Entry size | Previous write p50 / p95 | New write p50 / p95 | Previous / new read p95 |
| --- | ---: | ---: | ---: |
| 768 B | 12.9 / 15.6 ms | 20.8 / 24.8 ms | 3.54 / 2.55 ms |
| 30 KiB | 15.8 / 20.7 ms | 23.8 / 27.4 ms | 14.03 / 13.72 ms |

This is a storage-projection benchmark, not LLM latency. The added write cost is
about 8 ms in these samples and exceeds the earlier 10% warning threshold. Native
live text-only updates do not create presentation frames. The highly compressible
fixture added approximately 0.66 MiB of WAL per 240 commits, or roughly 2.8 KiB per
commit; percentages are larger for compressible/small bodies. There is no claim
that ordinary writes became faster. Host contention can affect these observations.

Raw synthetic evidence is kept outside Git under
`deploy/production/runtime/work-evidence/shared-forks-20261030/`:
`final-1g-context/report.json`, `deep-1000/report.json`, and
`ordinary-cost-optimized/report.json`.

## Reproduction

Run from a clean checkout with the maintained PostgreSQL test wrapper:

```sh
PI_CLOUD_FORK_CHECK_BYTES=1073741824 PI_CLOUD_FORK_CHECK_CONTEXT=1 \
  node scripts/run-with-test-postgres.mjs -- node --import tsx \
  scripts/run-fork-performance-check.mjs /tmp/pi-cloud-shared-fork-large

PI_CLOUD_FORK_CHECK_BYTES=8388608 PI_CLOUD_FORK_CHECK_DEPTH=1000 \
  PI_CLOUD_FORK_CHECK_DOCUMENT=1 \
  node scripts/run-with-test-postgres.mjs -- node --import tsx \
  scripts/run-fork-performance-check.mjs /tmp/pi-cloud-shared-fork-deep
```

`run-shared-history-cost-check.mjs` accepts an isolated schema-203 checkout via
`PI_CLOUD_HISTORY_COST_BASELINE`. Resolve that checkout's `@pi-cloud` workspace
packages to its own files; external dependencies must match the pinned versions.
Keep historical checkouts outside this repository so test discovery cannot pick
up their old suites. Both benchmark paths create/drop their own databases.

## Correctness gates

Targeted checks cover native Storage conformance, original ID ordering, late
reserved IDs, parent/child isolation, source deletion, current/document state,
continued child input, rollback, skipped collection locks, retained images,
schema-203 conversion, and bootstrap after pruning.

The full workspace run initially had 2,290 passes, 11 skips and one failure:
`/usage` on a new, empty native conversation required an ancestor that did not
exist yet. After the correction, four focused checks and the entire committed
Control Plane suite pass (550 tests). The composed workspace result is 2,291
passes and 11 skips, not a claim that the initial run was entirely green.

The fault run passed 378 of 379 cases. The remaining closed-writer case exceeded
its 30-second test budget while build and test work overlapped; its isolated
recheck and all four cases in the related file pass. This is a composed result,
not one all-green fault run. Typecheck, build, transport, deployment/helper,
format, dependency and all 12 matched-image gates pass.

The 1 GiB API/browser fixture passes pagination, search, export, restored reading
position, Tool disclosure, delayed-image anchoring and ongoing output. Its latest
page reads 2.01 MB in six SQL statements (529 ms); export contains all 16,528
Tool results (104.7 seconds). The separate complete Fork/prune check measured
825/547 ms for first/nested Forks and 3.28 seconds for source pruning. Retained
message-body counts stay unchanged across Forks. Logical view row counts in the
raw report describe visibility across branches, not duplicated physical bodies.

This acceptance driver now captures source presentation and settlement through
the current runtime functions, measures the actual retained-body query, and waits
for the browser's target rows/eviction rather than fixed scroll timing. Earlier
fixture failures remain in the private evidence. No Web behavior was changed to
make these assertions pass.

Collection is incremental. The fixture needed 17 accelerated batches of 1,024
to remove exactly the 600 discarded entries while preserving every retained
branch. A batch may remove metadata without deleting any message body; its body
count is not a completion signal. Production currently runs bounded batches of
64 on the existing minute timer, so large histories do not immediately release
all disk space. The fixture establishes eventual correctness, not production
cleanup latency; increasing that budget requires separate load measurements.

## Matched transition

The old allocation was closed and positively observed absent before replacement.
The original machine recovered as generation 28 with the same Workspace; it had
no running preview server before this maintenance. All 29 runtime Pods are Ready.
Fourteen protected database views/tables, 5,859 Workspace files and 27 private
configuration/credential hashes match the original values. All 65 previously
referenced images retain their bytes and hashes. The new immutable header index
also reconnects three pre-existing upload images, giving 68 retained images;
their creation times predate the transition and their header edges were checked.

Release evidence is private under
`deploy/production/runtime/release-evidence/shared-forks-20261030/`.

## Live acceptance

Real GPT-6 Luna checks pass on the deployed artifacts:

- Fork completed C while the source executes D; prune the source to B while the
  Fork executes F. The Fork recalls C and its retained image, the source recalls
  B without C, and the old physical store is retired.
- Compact and cold-reopen the Fork, then recall C again. The browser retains its
  independent navigation and image history.
- Stop/return/resend queued image input, preserve admission identity, and read
  oversized ASCII/Unicode through the guest and canonical Worker result.
- Interact with guest Chromium/canvas, view screenshots, display retained images
  after file removal, and open a named application preview from live/cold history.
- Consume/edit/stop/recover native inputs; preserve streaming progress after Stop
  and simultaneous Worker/Control Plane crashes, without per-fragment PG bodies
  or a duplicate Run. All five recovery cases pass.

Initial Cube/native runs passed their functional assertions but exposed missing
schema-204 dependency ordering in the **acceptance tenant cleanup helper**. After
confirming physical cleanup and absence of logical/native Sessions and writers,
the helper now removes that owned tenant's retained graph before image objects.
Eleven helper tests pass, including retained frame/image edges and preservation
of the operator's assets. Both full live suites were rerun successfully with
`accepted` and `cleanupConfirmed` true; earlier failure reports and explicit
cleanup receipts remain available. The final functional source is still
`f21b5b42`; the follow-up changes affect acceptance drivers/tests and documentation.

Final evidence: `live-fork/report.json`, `live-cube-final.json`,
`live-native-input-final.json`, and `maintenance/` preservation, image and state
reports. The machine remains generation 28 after the recovery tests; no fixture
Runs, writers, bindings or elastic VMs remain.
