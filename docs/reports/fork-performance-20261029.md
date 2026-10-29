# Large-history Fork performance, 2026-10-29

Source verification is in progress; publication and live preservation are not yet
claimed. [ADR-0285](../adr/0285-batched-native-history-forks.md) records the decision
and primary-source comparison of Git, Temporal, Dolt and PostgreSQL.

## Changes

Manual Forks copy existing Entry references inside PostgreSQL in bounded batches.
The same native IDs, provenance, document policies and byte-equivalent checksum
formats remain. Ordinary history bodies no longer make a PG → Node → PG round
trip. Only candidate image-bearing bodies return for the existing reference
validator. This does not change ordinary Worker commits or patch Pi core.

Frozen display descriptors are inserted in batches of up to 128. Image retention
filters candidates before paging, avoiding repeated sorting/paging of an entire
image-free history. Narrow SQL intermediates prevent repeated processing of large
checksum preimages. Source locking, target quiescence, rollback and FK-based
collection remain authoritative; no new storage service or schema is introduced.

## Isolated measurements

The actual Fork service runs against an isolated PostgreSQL database. The same
generator creates 1,074,614,914 bytes, 17,664 Tool iterations and 35,329 immutable
Entry bodies. Random paragraph contents differ between runs. These local timings
are observations, not a latency guarantee or a deployment load test. Byte counts
measure encoded application parameters/results, not TCP traffic.

| Measurement | Baseline | Optimized |
| --- | ---: | ---: |
| First Fork wall time | 193.0 s | 61.7 s |
| Nested Fork wall time | 123.3 s | 50.1 s |
| First Fork SQL calls | 83,431 | 2,001 |
| Nested Fork SQL calls | 11,125 | 1,181 |
| First Fork parameter bytes | 1,108.4 MB | 11.2 MB |
| First Fork returned bytes | 1,122.7 MB | 30.2 MB |
| First Fork Node CPU | 40.2 s | 2.0 s |
| First Fork peak Node RSS | 469.5 MB | 454.2 MB |

First-Fork phase times fall from 60.5 / 79.6 / 52.9 seconds for native import /
display metadata / images to 53.0 / 8.5 / 0.05 seconds. The image-free fixture now
does almost no image-retention work. Database checksum processing is the main
remaining cost. The first set-based prototype was slower in native import;
reducing SQL count alone was insufficient until wide intermediates were removed.

The retained Entry pool stays at 35,329 bodies and 1,067,587,979 payload bytes
after both Forks. Flat per-Session references still grow with retained records.
Cold source-tail retirement uses its existing native rebuild path and is not
claimed to have the same speedup. A constant-time branch would require a broader
range/tree ownership and checksum design; the measured improvement does not
justify introducing that complexity in this slice.

Reproduce with:

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/tsx/dist/cli.mjs --tsconfig packages/control-plane/tsconfig.json scripts/run-fork-performance-check.mjs /private/fork-performance
```

Private raw reports, including rejected intermediate measurements, are under
`deploy/production/runtime/work-evidence/fork-performance-20261029/`.

## Verification

The 36-test native history, child-family and image contract group passes. Added
cases verify exact JS/SQL hash equality, NUL/lone-surrogate/Unicode escaping,
32-record boundaries, task-identity removal, rebuild equality, no ordinary body
returned to Node and complete rollback when a shared source payload is corrupted.
The separate composed 1 GiB API/SSE/Web fixture passes paging, navigation, search,
export, image layout, live-tail anchoring and independent Fork/prune/collection.
With its different mixed-record history and other verification running on the
host, first/nested Forks take 103.9 / 73.5 seconds and cold tail retirement takes
162.1 seconds. Collection removes exactly the 600 unreferenced fixture bodies;
both Forks retain their expected history. These timings are not interchangeable
with the isolated service fixture above. Full repository gates and live rollout
evidence follow below when complete.
