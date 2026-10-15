# Projector review implementation

Status: implemented, verified and deployed, 2026-10-15. The owner authorized all repair slices from the
[review](projector-envelope-review-20261015.md). [ADR-0249](../adr/0249-compact-projector-publication.md)
records the protocol decision before implementation. The matched release is
`projector-compact-bf55d9bd` (source `bf55d9bddbbc202ad3b0c7306ddb64b23d4afcae`).

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

- A5: fixed Tool/workflow request schemas are separate;
  guest/Tool Worker protocol is 5, with managed Cube protocol 7 unchanged. Fixed
  Tools retain identity/time/output budgets and workflow retains context checks.
  Seven targeted files initially passed 123 cases and exposed one old fixture
  copying workflow context into a fixed request. The corrected workflow suite
  passes all 11 cases. The repository-wide typecheck and workspace tests pass.

## Delivery

- A6 is complete: source gates, matched release, real Luna/Cube/browser/native
  input/child-recovery checks and owned-resource cleanup have passing evidence.
  Failed attempts and operational follow-ups are distinguished below. The final
  documentation/fixture-only commit does not change the deployed runtime inputs.

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
- Final fixture cleanup removes retired close/lease aliases from two dispatcher
  suites; their 26 tests pass. Documentation/link and formatting checks pass.
  Recomputed guest/completion input identities still match the deployed candidate.

This records corrected and resumed CI stages, not a claim that the first complete
CI command exited successfully. Image vulnerability/provenance gates and live
acceptance are recorded separately below.

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

## Matched deployment

All eleven image provenance/SBOM/vulnerability gates and matched preflight pass.
Trivy's first database download exceeded its deadline; the same pinned scanner
downloaded the official database from GHCR with a longer download timeout, then
the complete maintained preparation passed. No scan or severity gate was waived.
Unused build cache was reclaimed to restore the required disk headroom.

The first apply stopped after native Cube replacement: template registration
overlapped node re-registration. Master was still trying the old Pod IP while the
new Cubelet was booting; no template VM reached that Cubelet. The failed release
correctly kept applications offline. After current-node inventory confirmed one
of one nodes and zero VMs, the same scanned candidate was applied again. All four
new templates became READY; registration removed obsolete templates. Application
deployment completed at approximately 13:12 Asia/Shanghai. Control Plane, both
Workers, Web, SSH and Volume Gateway are ready on the matching release.

Contracts: PG schema 189, execution Topic v17, boot reply v3, guest/Tool Worker
protocol 5, Cube management protocol 7. Accounts, model/provider settings and
credentials were not reset. The native-node readiness window is a separate
release-operator follow-up, not a reason to weaken VM absence or fencing checks.

## Live acceptance

All real-model checks use GPT-6 Luna. The [bounded evidence](projector-repair-20261015.json)
contains results without prompts, Tool output, image bytes or credentials.

| Check | Result |
| --- | --- |
| Full Cube production suite | Complete pass on the third attempt, 21 model requests: pure chat without a VM, coding, authenticated preview, warm VM/background-process reuse, tenant isolation and 1,024 fixture files restored on a fresh VM using the original Volume. |
| Native input | All five cases pass in one invocation: consume, stop, recover, stream_stop and stream_both_crash. Actual Worker/Control Plane SIGKILL, same-Run recovery, retained interrupted text, no PG streaming bodies and physical cleanup are checked. |
| Real browser and native Read | Complete pass on the second attempt: lost admission reply, Stop, returned draft/image, distinct resend identity, same uploaded image/direct vision, 120,017-byte ASCII and 140,031-byte Unicode inputs, valid source-truncated native results and diagnostic display. |
| Native child/control tools | Supervisor request/reply, messaging, two parallel children, cancellation and guest boundary each pass. These are an initial supervisor result plus focused invocations, not one successful full five-scenario run. Diagnostic messaging also verifies the marker in the child's history and its completed Bash. |
| Control Plane replacement during child Bash | Same-image rolling replacement takes 12.106 s in this sample. The same Worker completes the same root Run; native child/control reply recovers, the Bash marker proves one execution, and physical cleanup completes. This is not a cross-version availability guarantee. |

The first two full Cube attempts and first browser attempt fail on upstream
`chatgpt.com` TLS handshake EOF. Unauthenticated probes reproduce intermittent
TLS failure both through the runtime relay and directly through the existing host
proxy (one failure out of three on each path). This is consistent with the
[existing egress investigation](model-egress-tls-20261012.md); it is not fixed by
the Projector change. Failed samples remain recorded; no provider retry owner,
proxy route, credential or assertion was changed to obtain passing evidence.

The first combined child suite passes supervisor but its messaging answer does
not contain the expected marker. No Tool error is reported; that fixture's
original history is already removed by its cleanup, so its cause is not claimed.
The focused diagnostic run passes with the expected workflow input, child Bash
and received marker. All remaining focused child cases pass. During the intentional
dual-process fault, the replacement Worker also has two startup failures before
becoming Ready; the same-Run recovery check passes, without claiming zero fresh-Boot
startup retries while Control Plane is unavailable.

The short synthetic Bash envelope used by the baseline review shrinks from 2,081
to 1,408 bytes (673 bytes, approximately 32%). This measures that envelope only,
not whole-session compression, resident memory savings or production latency.
Tool-start/result descriptions now reference native bodies rather than publishing
the extra copied bodies reproduced by the baseline probe.

## Cleanup and preserved assets

- Native inventory confirms one of one nodes, zero VMs; authoritative PG has zero
  unfinished/unsealed Runs, live Session writers, VMs, machines or terminals.
- Browser/native-input fixtures remove their own accounts and images after physical
  purge. Three Cube-suite tenants (including failed attempts) are removed through
  the owned-acceptance helper. Seven task-created projects/Workspaces and six released
  runtime records under the original account are removed only after Volume purge,
  allocation closure and absence of dependent Runs/Sessions are confirmed.
- Old execution Topic v16 is deleted after checking zero unsealed old-topic Runs,
  replay references and active writers. Its 30 obsolete PG projection-offset rows
  are removed. Topic v17, the current Projector group and boot reply transport remain.
  Native PG history does not require an old-format reader.
- All four current guest templates are READY; the failed/previous templates are
  removed by maintained registration cleanup. The task's temporary build proxy relay,
  diagnostic CA image and temporary build probe directory are removed.
- Original tenant/user/password/model/binding/source-control tables match their
  pre-release whole-table fingerprints and counts. Counts remain 32 tenants/users,
  five password records, 35 models, 35 bindings and zero source-control credentials.
  API credentials remain 32, with none created or revoked since the baseline;
  authentication refreshes one `last_used_at`, so its whole-row fingerprint is
  explicitly not reported as identical. Usage timestamps are not restored to make
  a checksum comparison pass.

The existing external AnyTLS-path issue, permanent Docker daemon proxy configuration
and native Cube registration/readiness window remain documented operational work.
No compatibility decoder, new execution authority or extra queue/store is introduced.

Private intermediate logs remain under `/tmp/pi-cloud-projector-*`; they are not
committed transcripts or credentials.
