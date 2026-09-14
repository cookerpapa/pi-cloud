# Direct Workspace storage acceptance

Date: 2026-09-14. Implementation base: `a4984f5f`; the tests below ran against
the modified implementation worktree and migration 138, not unchanged `a4984f5f`.
The generated latest reports record that Git base. One-host Compose, real
CubeSandbox v0.6.0 KVM, RF3 Kafka, PostgreSQL and two Pi Workers were used.
The implementation was committed as `34cc7aa7`; release images were rebuilt
from that commit after the final equivalent release-request simplification.

## Changes

- Remove Workspace reference loading/capture/commit on every Run and its
  staged head/CAS, synthetic content revisions, object table and Worker cache.
- Remove full raw Tool-output archives, local archive files, Artifact IDs and
  recovery links. Preserve bounded native Tool Results, honest truncation, and
  the Broker's existing transient delivery cache/no-replay contract.
- Record environment validation at activation, once per environment version,
  independently of files and Run success. Preserve full-VM persistence.
- Copy independent Workspaces using source physical Volume generation and
  target identity; retry does not recopy changed files or adopt a recreated source.
- Drop `runtime_objects`, `artifacts`, `workspace_settlements` and their obsolete
  columns. Preserve native Session/Lane history, Lease/Fence, seals and actual files.
- Remove retired cache configuration, metrics, exports and the obsolete ADR.

## Evidence

- Full existing suite: 807 passed, 11 conditional integration skips. Additional
  activation-validation and recreated-copy-source regressions passed with the
  socket-backed PostgreSQL-compatible test driver. Real production PG was also
  exercised by every live flow. Build and type checks passed.
- Empty-schema migration and repeat migration passed; the three archive tables
  are absent. Migration 138 also succeeded against the deployed PostgreSQL.
- 26/26 deterministic fault targets passed. The obsolete stale-settlement test
  was replaced with the recreated-Volume/copy boundary, not silently skipped.
- GPT-5.6 Terra paid Cube acceptance: chat creates no Cube; coding rounds reuse
  one VM; HTTP preview and background process survive; destroying the source VM
  preserves 1,025 files on the Volume, and a fresh VM reads them without an archive.
  The recovery Run adds its proof file, yielding 1,026 files.
- DeepSeek V4 Flash/low: 11 Subagent groups passed, including fresh/branch,
  no-Tool/lazy/shared/isolated placement, recursive coding, communication,
  supervisor response, cancellation and child/tree views. Recorded usage:
  17,659 input, 5,247 output and 185,088 cache-read tokens.
- Cookie-authenticated product API/SSE acceptance passed twice: creation,
  conversation Fork/pruning, code/file browsing, Terminal + Agent concurrency,
  two Sessions using one Workspace simultaneously, Steer, cancellation/recovery,
  tenant isolation, resource deletion and Workspace rebinding.
- A real 150 KB Bash output retains a bounded head/tail and the explicit
  no-archive warning in native history, with no Artifact field or recovery link.
- Exclusive-machine acceptance passed: `/etc` and home files, background process,
  pause/resume, Broker restart adoption, SSH, selected working directory, shared
  child execution and HTTP preview. Release deletes machine storage and preserves
  the conversation until the test explicitly deletes it.

Across this slice's paid checks, including the two failed test-prompt preflights,
native assistant usage records totalled 129,997 input, 9,769 output and 586,772
cache-read tokens (127 recorded assistant messages). These are observed usage
fields, not an estimate of all upstream billing or an active-concurrency claim.

The initial Subagent lazy test allowed the model to submit `tools:[]`; the
platform correctly derived `none`. The test now explicitly enables unused Bash.
The machine test also contained a retired `agent:"cloud-child"` workflow option;
it was corrected to the current role-free API. Live script entrypoints now load
TypeScript through `tsx`, avoiding Node strip-only failures on dependency imports.
Neither issue was hidden with production compatibility handling.

## Latency and limits

The final product API/SSE sample measured pure-chat first text at 2,920 ms:
2,726.899 ms on the provider route and 193.048 ms elsewhere. Parsed text to Pi
event was 0.737 ms; event to client receipt was 9.947 ms. This measures receipt,
not browser paint. Coding first text followed earlier model/Tool steps and is
not comparable to a single model's first-text interval.

This removes known Workspace-only RPC/PG/filesystem barriers; it is not a matched
before/after throughput benchmark. Full multi-node HA and the wider repository
review remain separate work. Native conversation Compaction/stream contracts
were covered by the existing suite; this slice does not claim a new paid
long-context stress run.

## Cleanup

The migration intentionally removed 75 pre-existing obsolete runtime objects;
recovery of those bytes requires a prior database backup. No Workspace/Session
existed at cutover, and account/configuration data was not reset. Live scripts
released their VMs and purged their Volumes. Seven temporary tenants and the
three explicitly identified fixture projects in the bootstrap tenant were
removed after all Runs/seals finished and physical purge was confirmed.
Cleanup used the existing local PostgreSQL administrator and a transaction-local
trigger bypass for cyclic fixture references; all surviving foreign keys were
checked before commit. It added no production authorization bypass.

Final checks found zero Runs, Sessions, native Session entries, Workspaces,
development machines or Cube instances, with an empty Workspace Volume directory.
All 35 original users remain. User rows, password-credential rows and model-profile
rows have exactly the same aggregate digests as before this slice. No provider
account or provider-side usage accounting was cleared. Kafka remains subject to
its ordinary safe-retention policy; no live topic/offset reset was performed.
