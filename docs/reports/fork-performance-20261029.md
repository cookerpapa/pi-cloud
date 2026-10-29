# Large-history Fork performance, 2026-10-29

Published as `fork-performance-brotli-20261029`, schema 203 / Helm 124, from
`e47ece922b079ee649d96790c760c7fbdc6d8fbc`. Live acceptance and original-asset
preservation pass.
[ADR-0285](../adr/0285-batched-native-history-forks.md) records the decision
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
with the isolated service fixture above. Repository gates and live rollout
evidence follow below.

## Release preparation

The first candidate was blocked by the fresh image database on
`CVE-2026-111497` in the Ubuntu Brotli library. Its findings apply to Cube Master
and the guest image, not to the Fork algorithm. Pin the distro fixes
`1.1.0-2ubuntu0.1` (24.04) and `1.0.9-2ubuntu0.1` (22.04), as listed in
[Ubuntu's advisory](https://ubuntu.com/security/CVE-2026-111497), and rebuild the
matched artifacts. Do not suppress the finding or weaken the existing image
gate. The final twelve-image gate passes. This adds no runtime protocol or
database change. A stalled native-package download was retried; 31.26 GB of old,
unused Docker build cache was reclaimed to satisfy the disk preflight. No
Workspace or database data was removed for these build failures.

The local full check passes 2,399 tests with 11 configured skips; all 375 fault
cases, transport integration, build, policy and dependency gates pass. Remote
run `40804779296` passed every image job, but its quality job was cancelled at
the configured 20-minute limit while running the PG storage suite. Increase that
job's bounded budget to 60 minutes; no tests or per-test timeouts are removed.
The source fault report records application commit `dcc093cb`; the subsequent
image-only fix changes no application behavior.

## Deployment and live acceptance

The matched candidate passes all twelve image scans and artifact preflight. Old
compute was closed and confirmed physically absent before clearing its live
handle; the persistent Workspace and running intent were retained. The same
development machine recovered as generation 26 with a fresh allocation. Its
previously running application on port 4188 was restarted and serves identical
HTML. The final inventory has 29/29 ready Pods and no active fixture Runs,
writers, Tool bindings or elastic VMs.

Owned fixtures use `gpt-6-luna` and the actual deployed services:

- Independent Forks: Fork completed C while source D runs; prune source to B
  while Fork F runs; retire the source's old physical store. The source recalls
  B without C, while the Fork recalls C and its retained image, including after
  native compaction. Browser navigation remains independent. Cleanup is confirmed.
- Cube/browser: Bash Stop, lost-response/returned-input behavior, image resend,
  source-side 50 KiB Read truncation with valid UTF-8, Chromium interaction,
  screenshot, `show_image` and live/cold named preview links all pass. Cleanup is
  confirmed.
- Native recovery: consume, Stop, Worker SIGKILL, stream Stop and combined
  Worker/Control Plane crash cases all pass, retaining retry identity and the
  native pending-input semantics. The transient kubectl “container not found”
  response during intentional Control Plane replacement is retained in private
  evidence; actual restart/recovery checks complete successfully.

Preservation compares all original rows across fourteen account/config/history
tables, including three conversations. All 65 referenced image blobs retain
their bytes. The 5,859-file Workspace inventory matches apart from the expected
application log and process-ID runtime artifacts; all 27 configuration/credential
hashes match. No original conversation was used as an acceptance fixture.

Private deployment, preservation and live reports are under
`deploy/production/runtime/release-evidence/fork-performance-20261029/`.
The final documentation/CI-only commit does not require replacing the verified
runtime artifacts; its remote quality run uses the extended time budget.
