# Sandbox capability refactor and current documentation

Date: 2026-10-31. Baseline: `b2aa6168`. Runtime source: `bc82d8dc`.
Matched release `sandbox-capabilities-20261031` is deployed on schema 205,
platform Helm revision 131. Cube is revision 195 and infrastructure revision 101.

## Scope

The provider composition is divided into lifecycle, execution preparation,
Workspace files, images, terminals, previews, workflows and Git credentials.
SandboxController retains all ownership, allocation and closure coordination.
WorkspaceFileAccess receives the file port and callbacks to the owner's existing
admission checks. It adds no network hop, state authority, output copy or retry.

The documentation map and architecture are organized around current behavior.
The former map's report/research links are retained in [the evidence index](README.md).
Evaluation's retired Worker-to-control-ingress path is corrected to direct Kafka
publication. ADRs retain design rationale and reports retain dated evidence.

No Pi version, schema, public protocol, tool behavior, storage retention or runtime
provider changes. Project text discovery/Skills, tracing expansion and Pi upgrades
remain separate proposals. [Research](../research/pi-runtime-adapter-comparison-20261031.md).

## Verification and publication

The targeted 107 tests pass, including seven file-capability cases and existing
controller, Cube-provider, shared-compute and recovery-publication checks. The
sandbox-control typecheck passes. A TypeScript declaration comparison confirms
all 39 provider member signatures and their optionality are unchanged.

Documentation checks and an additional traversal of changed Markdown links pass.
The architecture is reduced from 1,886 to 403 lines and the navigation page from
900 to 56; dated evidence links have their own 182-line index. Runtime policy,
build-context/image closure, Helm rendering, observability, formatting and build
checks pass. The complete workspace/helper gate passes 2,412 tests; its 11 existing
opt-in skips remain. All 379 deterministic fault cases pass. The fault run started
before the source commit and retains its `b2aa6168`/dirty-worktree stamp; runtime
source was unchanged between that run and `bc82d8dc` publication.

The maintained matched procedure built/reused and scanned all 12 required
artifacts. Read-only preflight, KVM availability, quiescent ownership and positive
old-node absence were confirmed before the application/Cube cutover. The registered
guest artifact was reused; no template or runtime fallback was introduced.

## Deployed acceptance

- An owned file-only fixture exercises public upload, read and directory APIs on
  elastic and dedicated-machine Workspaces. Uploaded UTF-8 bytes round-trip exactly.
  Elastic file access creates no VM. A paused machine refuses a read, then resumes
  the same allocation with identical bytes. Its VM, Volume and tenant are removed
  only after confirmed physical cleanup.
- The maintained guest-browser fixture passes with real GPT-6 Luna: Chromium
  interaction/canvas, screenshot vision, live/cold show_image, retained image after
  source-file deletion, and actual navigation through the named Preview link.
  It uses six model requests and is fully cleaned afterward.
- The maintained native-input driver passes all five scenarios: consume, Stop,
  Worker crash recovery, streamed-text Stop and simultaneous Worker/Control Plane
  crash. It confirms native queue identity, retained partial text and absence of
  PG streaming bodies. Owned execution and storage resources are reconciled and
  its temporary tenant is removed.

These are single-host checks, not fleet-capacity or physical-node HA claims.

## Original assets and operational observations

Both original development machines keep their logical IDs, intent and Workspace
Volumes. Matched compute replacement advances their generations from 32 to 33 and
2 to 3. The later recovery fixture preserves those new allocations. The original
application is running again with its captured proxy environment and its original
HTTP page hash.

The application-restore helper initially exceeded its 1 KiB diagnostic output
bound while polling startup. Inspection confirmed the application had started
successfully. Its probes were made quiet and the helper output bound widened;
the idempotent verification then completed without launching a second process.
No product/runtime behavior was changed to handle this operator-only failure.

All 5,889 Workspace files match across the stopped-machine deployment before
application restart. The active pre-retirement snapshot and final running checks
separately account for the original application's changing log and data snapshot.
All other files, four original conversations, 14 protected table/view contents,
101 retained image objects and 27 private configuration/credential hashes match.
The final state has 29/29 serving Pods Ready, no active Runs, writers or Tool
bindings, and no remaining acceptance elastic VM. Original dedicated compute stays
running. Private logs, application data and credentials are not committed.
