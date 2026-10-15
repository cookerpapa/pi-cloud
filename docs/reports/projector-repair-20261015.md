# Projector review implementation

Status: source verified; matched rollout in progress, 2026-10-15. The owner authorized all repair slices from the
[review](projector-envelope-review-20261015.md). [ADR-0249](../adr/0249-compact-projector-publication.md)
records the protocol decision before implementation. No release has occurred yet.

## Completed source slices

- A1: the private projection prefix now stores only display progress and uncovered
  event IDs. Forced and ordinary writer closure share whole-family cleanup.
  A real PGlite/native projection test checks two children, writer closure,
  preserved next display positions and repeat closure. Four targeted files / 31
  tests pass, including native checkpoint/closure and handoff contracts.
- A2: per-record native write indexes preserve first-match intent lookup and
  native batch order. Kafka decode returns prepared dispatches; Projector reuses
  them, control reconciliation retains only the validated reference, and Worker
  boundary checks no longer repeatedly expand the same dispatch. Six targeted
  files / 37 tests pass. Runtime-core typecheck passes.
- A3: compact execution-topic v17 envelope is implemented. Child view addresses
  and the original Boot reply Topic round-trip; duplicate aliases and standalone
  cancellation publication are removed. Internal commands remain expanded objects.
  Projection locks one root Run before its lease. Targeted envelope/PG/handoff
  tests pass. The broader runtime tests exposed one obsolete multi-Run probe
  fixture; it now uses native child views, and its five tests pass.
- A4: same-commit Tool-start/result references now provide public presentation.
  Arguments reference the admitted checkpoint; canonical result parts reference
  the post-hook Entry. The old post-commit Tool body publisher and its PG identity
  lookups are removed. Text and Tool descriptions share an events collection.
  Forty initial presentation/protocol tests pass; real Pi/native PG/child history
  checks pass (five files / 20 tests). A direct invocation without the maintained
  PG wrapper timed out in database setup; it was rerun with the isolated official
  PostgreSQL fixture, not counted as passing initially.

## Remaining work

- A5 is source implemented: fixed Tool/workflow request schemas are separate;
  guest/Tool Worker protocol is 5, with managed Cube protocol 7 unchanged. Fixed
  Tools retain identity/time/output budgets and workflow retains context checks.
  Seven targeted files initially passed 123 cases and exposed one old fixture
  copying workflow context into a fixed request. The corrected workflow suite
  passes all 11 cases. The repository-wide typecheck and workspace tests pass.
- A6: required checks, full matched release, real Luna/Cube/browser/native-input
  acceptance, obsolete-resource cleanup and final documentation.

## Repository verification

The complete CI invocation on `0f850dab` passed dependency preparation, formatting,
documentation, installer/runtime policy, native Cube admission/allocation,
Helm/observability/image closure, build, all workspace typechecks/tests and 71
acceptance-helper tests. Its real transport stage exposed one regression: a
proved oversized-record rejection had been wrapped as invalid-message failure.
`3d2cc95e` restores the specific transport-budget rejection outside that catch.

After that repair:

- Runtime-core typecheck and 78 unit tests pass; two conditional transport/PG
  tests are skipped in that isolated package invocation. The earlier repository
  run used its maintained PG wrapper, and real transport is checked separately.
- All seven real PostgreSQL/RF3 Kafka transport files pass, eight tests total,
  including direct publishing, delayed initializer fencing, ordered cancellation,
  control-plane replacement, same-Run recovery and control-view reconstruction.
- The maintained fault evaluator passes 243/243 cases on `3d2cc95e`.
- Dependency security audit passes with no remaining vulnerabilities reported.

This records corrected and resumed CI stages, not a claim that the first complete
CI command exited successfully. Image vulnerability/provenance gates and live
acceptance remain part of the matched release below.

Before release, authoritative PG checks show zero unfinished Runs, unreleased
writers, VMs, machines and terminals. Native inventory confirms zero sandboxes
on one of one registered nodes. Preservation fingerprints cover the original
32 tenants/users/API credentials, five password records, 35 model profiles,
35 credential bindings and zero source-control credentials; raw rows/credentials
are not exported or committed.

## Artifact preparation

The first guest build hit a GitHub TLS EOF fetching pinned envd source. Retrying
the same pinned commit succeeded. Ubuntu downloads then repeatedly returned 502
through the existing proxy. The maintained guest Dockerfile now uses the same
Aliyun mirror family as the existing Debian/Alpine build paths; Ubuntu signatures,
explicit OpenSSL pins and later vulnerability scans remain enforced. No runtime
proxy/provider configuration or dependency version was changed by this repair.
The same proxied Ubuntu 502 recurred in the pinned Cubelet base Dockerfile; its
existing build/security patch now applies that mirror and bounded APT retries too.
The patch digest is updated and the entire pinned patch sequence is checked.
Docker's configured old loopback proxy endpoint also caused manifest timeouts.
A temporary local TCP relay to the existing proxy restores build-time access;
it must be stopped after release and does not complete the separate permanent
daemon-proxy configuration backlog item.
The pinned Rust builder image was inspected offline and already contains rustc
1.85.1 (`4eb161250`) and Cargo 1.85.1. Upstream's `1.85` alias nevertheless caused
another installation of those same binaries on each rebuild. The existing patch
now names `1.85.1` exactly; an offline container check verifies use of the installed
toolchain. This tightens the build pin without changing the compiler version or
runtime protocol. The redundant in-progress candidate download was stopped first.
The HTTPS mirror exposed that the minimal Cubelet runtime base initially has no
CA bundle. Its build now bootstraps public CAs from the already pinned Go builder,
then installs Ubuntu's own ca-certificates package. APT fails on any index error;
certificate and repository signature verification remain enabled.

Private intermediate logs are under `/tmp/pi-cloud-projector-a1-*` and
`/tmp/pi-cloud-projector-a2-*`. They are source checks, not a serving release.
Preserve the Session producer fencing and all existing closure, PG authority,
Tool dispatch and physical resource cleanup boundaries throughout the remaining work.
