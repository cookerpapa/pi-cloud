# Native input matched release

`native-input-a71a4807` is deployed on October 9, 2026 from clean application
source `a71a4807a884190325b1a8230625f0a46a858ee1`. Schema 183 removes `turns` and
uses the Session/Run and native input contracts in
[ADR-0238](../adr/0238-native-input-queue-and-run-record.md).
Pi Durable remains 1.0.0; guest/Tool Worker protocols remain 4 and Cube management 7.

[Bounded evidence](native-input-release-20261009.json) records artifact identities,
test results and preservation checks. Private build, scan and acceptance reports
remain in `dist/releases/native-input-a71a4807/`.

## Deployment

The maintained matched procedure built seven application and three native Cube
images, reused the exact registered guest digest, and scanned all eleven images.
The existing zero-fixable-HIGH/CRITICAL gate and artifact/source checks passed.
There were no active Runs, writers, pending returns or native VMs before cutover;
native inventory covered 1/1 nodes. Old applications were stopped before migration
and the matched application/Cube release was installed. No business reset or
account/configuration deletion was needed for migration.

The initial real-model tests exposed an operational egress failure: the persisted
upstream proxy `127.0.0.1:12450` timed out, while the current host proxy at `10808`
reached the provider. The private runtime setting and declarative infrastructure
Helm values were corrected. A direct Luna request then completed, followed by the
full acceptance runs below. Earlier provider failures remain failed; no uncertain
Tool effect was replayed to obtain a successful result.

Final Helm revisions are Cube 61, infrastructure 31 and platform 31. The Web,
Control Plane and both Workers serve the new application image version. Public
Web, admin and Control Plane readiness return HTTP 200.

## Acceptance

- Native follow-up and promotion execute inside one Run. Edit/order changes,
  same-key retry, cold human-message ordering and replay after closure pass.
  Stop returns the unconsumed edited messages in order.
- A real browser loses an accepted native-input response, preserves its draft,
  removes only the draft image, then restores text/image after Stop. Resubmission
  has a new intent and Run; Luna reads the attached image without a Read Tool.
- Real guest Read returns bounded ASCII and UTF-8 prefixes with canonical
  truncation diagnostics, including an oversized Unicode line.
- Full Luna/Cube acceptance passes with 21 model requests: pure chat without VM
  activation, multi-round coding and authenticated preview on a warm VM,
  background-process survival, tenant isolation and persistent Workspace files
  attached to a fresh VM after the source VM is removed.

The operator drivers required corresponding contract changes. A Kafka/native
acknowledgement does not guarantee the PG queue view is already current, so the
native driver now waits for the intended projected input before editing and
uses mutation-returned revisions. Cancellation acceptance is not terminal
settlement, so cleanup waits for terminal state and the native seal. The browser
driver now uses `inputId` and expects two actual Runs instead of a holding Run.
These are operator-only repairs; the deployed application artifacts are unchanged.
Nine operator-fixture regression cases pass, and the shared cleanup adapter
removed the recorded native/Cube fixtures after physical purge confirmation.

## Preserved state and completion

All owned test Sessions, Runs, Workspaces, projects, images and native VMs are
removed. A foreign-tenant isolation project's already-purged metadata was deleted
by its exact recorded IDs while preserving that original tenant.

The original 29 users/tenants, 30 model profiles and credential bindings, four
password-credential rows and 29 API credentials remain. Before/after fingerprints
match for those records and platform settings, excluding access timestamps and
resource/version counters. The intentional operational egress-address correction
is separate from those preserved PG model/credential records.

The earlier [source verification](native-input-run-consolidation-20261009.md) is
now followed by an actual matched deployment. No pilot usage, physical-node HA
or wider fleet-capacity claim is made. The [reading checkpoint](../READING_PROGRESS.md)
remains at initial-message PG acceptance, before Worker claim/lease admission.
