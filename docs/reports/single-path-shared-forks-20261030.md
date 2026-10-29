# Single-path shared Fork verification

Implementation: [ADR-0287](../adr/0287-single-path-shared-forks.md), schema 204.
Status: source verification in progress; matched deployment and live acceptance
have not completed. These measurements do not establish a fleet SLA.

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
schema-203 conversion, and bootstrap after pruning. Full workspace/failure tests,
matched image gates and live Luna/Cube recovery acceptance remain release gates.
