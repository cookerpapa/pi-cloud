# Decoupling, resource backends and scoped release delivery

Date: 2026-11-13. Issues: #30, #31, #33–#37. Decisions: ADR-0315–0320.

The seven implementation slices are deployed and exercised on the existing
single-host K3s installation. Pi remains in trusted Workers. PostgreSQL owns
control state, Kafka orders Session changes, and execution adapters own native
mechanics. No vendor engine patch, replacement scheduler or compatibility mode
was added.

## Delivered behavior

| Issue | Result |
| --- | --- |
| #30 | Workspace persistence is independent of compute. The existing XFS helper owns initialization/deletion and capacity; Cube's supported plugin and BoxLite retain exact attachment receipts. Missing known storage cannot become an empty replacement. |
| #31 | Administrators register existing Cube/BoxLite backends through a versioned PG directory. Management and execution reconcile it without process replacement; open resource pages refresh automatically. Users select backend/template when creating Workspaces or machines. Existing Android devices are registered for an explicit organization and bound from the resource page. |
| #33 | One classifier serves CI and manual publication. The operator plans builds, serving roles and physical maintenance separately, preserves exact provenance for reused images, and supports metadata-only Chart changes. Shared or unknown changes retain coordinated publication. |
| #34 | The Skill surface is `skill` plus `publish_skill`. Personal uninstall uses a non-reused installation revision; published packages, other scopes, prepared files and the current Run's frozen selection remain intact. |
| #35 | Ordinary control dispatch no longer queries Worker lease validity. Cold identity/closure checks, native task state, partition ownership and business/resource admission remain. |
| #36 | API, Session runtime, resource management and ordinary Tool hosting load their own configuration and clients. Helm mounts follow the same boundaries. |
| #37 | Worker images omit Control Plane/accounting source and copy only three sandbox HTTP-client files. The file gateway copies twelve storage/HTTP files and no unrelated database/domain/event-log/attachment implementation or Kafka native module build. Role import checks and actual image startup verify these subsets. |

Registration provides connectivity to an already installed, supported adapter.
It does not install a cluster, create a VPN, replicate files, provision an Android
pool or load user-written server code. Changing executable template/connection
identity retains resource-quiescence checks; display labels can change independently.

## Serving artifacts and publication measurements

Schema is `222_resource_backends`; Session topic v21, reply topic v4, resource
capsule 4, fixed Tool payload 7 and Android executor protocol 2 remain current.
The fixed Guest identity remains `cb9f9036327beac98311f056e125bcfc7b5495dd`.

The final deployment record is `decoupled-metadata-20261113` at `f183d433`.
Its component identities deliberately differ:

- Core/API/execution/management, Worker, file gateway and SSH: matched r4,
  source `de9f4def`.
- Ordinary Tool host: `decoupled-tool-host-20261113-r2`, source `7dd27767`.
- Web: `decoupled-web-20261113-r4`, source `aac41d2d`.
- Unchanged CLIProxyAPI, egress and stock Cube artifacts retain their original
  image/source evidence. BoxLite's independently published node uses the r3 host
  parent; Android retains its verified executor/runtime artifacts.

| Observed operation | Build/scan effect | Runtime effect |
| --- | --- | --- |
| Initial storage/registry cutover r2 | 6 images built, 8 reused; old scan records needed fresh database identity evidence | Ordered application/compute retirement and cold storage adoption |
| Compatible r3 application update | 3 images built/scanned, 11 image/scan records reused | Both original VM allocation identities remained unchanged |
| Ordinary Tool host update | One shared host artifact | Only Tool host replaced; original Run, Worker, lease/fence, VM and other Pods remained unchanged |
| Web update | One Web artifact | Only Web Pod replaced; all other component provenance and original machines unchanged |
| Chart 0.1.0 → 0.1.1 | Zero builds/scans | `--no-hooks`; unchanged Pod identities; zero restarts |

The successful Tool-host replacement took 32.587 seconds. During it, 106 API
reads succeeded with a maximum observed latency of 12 ms and a follow-up was
accepted. The same Run used the new tool directory on its next model request;
the original Bash executed once. Preview and one image-generation call succeeded;
the retained image reference resolved to 695,373 bytes with matching SHA256.
These are single-host acceptance measurements, not fleet throughput results.

Docker-reported Worker artifact size changed from 130,220,377 to 126,708,060
bytes; the file gateway changed from 145,198,489 to 139,748,789 bytes. The source
subsets also remove unrelated provider edits from those image build inputs.

## Acceptance evidence

Heavy suites, builds and native/model scenarios ran serially. Main Agent checks
used `gpt-6-luna`; the configured image route used `gpt-image-2`. No 131 MiB cold
model request was required.

- The full 432-case fault matrix passed at `7bc50c8c`; RF3 transport passed all
  11 tests. Full workspace checks and subsequent affected type/unit suites
  covered the later API, registry, image and operator changes. The Web scope
  passed 277 tests plus full presentation, queue, Skill-market and history-layout
  browser suites. Gates were not removed when old assertions failed.
- Final format/documentation, role-image closure and all maintained Helm checks
  passed. The final operator/helper suite passed 315 tests; its PostgreSQL-only
  retirement test was then run against real PostgreSQL and passed separately.
- Native XFS checks covered quota initialization/growth, upload cancellation and
  resume, ordinary Bash writes, root-owned file deletion and mount identity.
  Mount tests covered wrong pools, duplicate attach, stale detach, missing
  receipts and zero native references while retaining original bytes.
- Six Skill model Runs covered instruction-only access without a VM, automatic
  execution-file preparation, version selection, personal uninstall/current-Run
  retention, next-Run exclusion, stale uninstall after reinstall, publication and
  duplicate publication.
- Native input checks covered editing, ordering, steer, Stop withdrawal,
  Worker recovery and Worker/Projector failure during streaming. PG did not
  accumulate streaming text bodies. API replacement left its Worker/Projector
  intact. A Worker replacement resumed the original pending Cube operation and
  received its original reply with one physical effect.
- Browser upload acceptance sent six files totaling 60,863,574 bytes after Send,
  including a 24,163,414-byte image. Local preview preceded upload. Reload and
  direct vision worked; overwriting the Workspace copy preserved the original;
  a replacement Worker recognized a previously unasked visual attribute. The
  relevant PG body was 1,766 bytes of references, not image pixels.
- A real Cube Run remained active while BoxLite was registered. An already-open
  Resources page discovered it; every existing Pod/restart counter, the original
  writer and VM remained unchanged; its held Bash finished once.
- With Cube API stopped, BoxLite completed public uploads, terminals, previews,
  pause/resume, expiry, new-compute retained-file reads and physical deletion.
  A separate resource-page scenario created the selected Box Workspace and grew
  enforced capacity to 40 GiB while Cube API was unavailable. After API restoration,
  Cube wrote a file and was positively retired; BoxLite used the same host
  inode/device/content/UID without a copy. Box API restart retained its VM. A real
  Agent then read both providers' markers through the selected Box backend.
  This proves the local persistence/adapter contract, not live cross-cluster migration.
- Android's six actions, retained screenshots, explicit-organization registration
  and resource-page unbind/rebind passed. Separate recovery checks preserved the
  original reply/deadline after Worker replacement, preserved native cancellation
  against late results, and did not replay an action after receiver loss. A full
  emulator restart retained an owned setting/file and the original userdata file;
  temporary markers were removed.
- Scheduling passed tool creation, browser edits/pause/resume, one admission
  across a management crash, same-Run steer while busy, and retention of an
  already accepted Run after its plan was deleted.

Maintained drivers include `run-live-resource-backend-check.mjs`,
`run-live-boxlite-lifecycle-check.mjs`, `run-boxlite-node-live-check.mjs`,
`run-live-android-check.mjs`, `run-live-android-restart-check.mjs`,
`run-live-tool-host-release-check.mjs`, `run-live-native-input-check.mjs` and
`run-live-user-upload-check.mjs`. Their source records the opt-ins, owned-resource
boundaries and cleanup requirements. Private logs/reports remain outside Git;
session transcripts, credentials and user files are not publication artifacts.

## Failed samples, fixes and operational limits

Live checks found a normalized native-template shape mismatch, a dropped
Workspace backend selection, stale test assertions/mocks, import-entrypoint and
catalog-file ownership bugs, and device registration incorrectly selecting the
administrator's organization. Each was corrected and its affected gate rerun.
The image-generation check initially expected inline pixels in PG; the corrected
check verifies the retained reference and actual object bytes. An initial browser
load was interrupted by `ERR_NETWORK_CHANGED`; the unchanged suite subsequently
passed. Scoped publication still uses the full applicable guards.

Cold adoption found two October released-machine rows missing a later-added
absence flag and three old owned provider-test Workspaces whose bytes had already
been removed. Fresh cold physical checks and kernel quota release preceded exact
metadata reconciliation. Original accounts/configuration were retained. No
compatibility path or empty substitute was added to pass adoption.

The 20 GiB WSL host had about 2.8 GB available during an Android recovery sample,
below the unlimited Workers' 3.15 GB admission reserve. Its Run stayed queued;
it had not reached Tool execution. Acceptance temporarily used explicit 2 GiB
Worker cgroup budgets with the existing guard intact. The three recovery cases
passed, and the exact original Worker configuration was restored.

Local XFS is not distributed storage. Wrong-node/pool contracts are checked, but
multi-node storage and hosted-provider persistence remain unverified. BoxLite's
documented no-jailer host profile remains an explicit limit. Stock Cube sampled
compute coverage is unconfirmed/unpriced; BoxLite has no compute observation
producer. Model and storage-capacity accounting retain their independent evidence.

One original upload-area locator has a stale guest inode after VM recreation.
Its background cleanup is conservatively deferred. This rollout did not rebind
that locator or delete uncertain user staging bytes; new upload/retention checks
passed. It remains an operational follow-up, not evidence of missing user files.

## Final preservation

The recorded 394 original files, original accounts/model/provider configuration
and credentials passed verification. Both original dedicated machines retain
their stable identity and files; their physical allocation identities survived
the later compatible/scoped updates. Android userdata identity is unchanged.
Owned acceptance resources and fault ConfigMaps are gone, no Run is left active,
optional Android/Box nodes are back at zero, and the Box backend is disabled until
an operator starts and enables it. Temporary Worker memory settings were restored.
