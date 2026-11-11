# Platform-owned elastic idle expiry

Issue [#29](https://github.com/cookerpapa/pi-managed-agents/issues/29) implements
[ADR-0314](../adr/0314-platform-owned-elastic-expiry.md). Source `5fc93d75` is
deployed as `platform-idle-20261111-r1` on the existing single-host K3s/WSL
installation. Schema 218 and resource capsule 4 replace the previous matched
contract. Session v20, replies v4, Guest executor 1 and Tool payload 7 are unchanged.

## Behavior

The existing resource manager is the single idle-expiry authority. Fresh fenced
Session activity and authorized terminal/preview use are coalesced into bounded
PG updates. The deadline is the maximum of its existing value and the original
activity time plus the recorded idle window. Renewal neither calls Cube nor
creates a VM. Diagnostics, adoption and stale declarations cannot extend it.

The controller conditionally claims due allocations, closes dispatch admission
and uses the ordinary provider deletion path. Unconfirmed deletion retains
ownership and quota. Dedicated machines have no idle deadline. Managed Cube
create/resume disables native timeout, removing the competing renewal path.

No vendor source patch, new scheduler, per-Tool lease query or operation ledger
was added. Compute observations remain unconfirmed/unpriced. The common policy
removes the native AutoStop prerequisite for the separate BoxLite integration.

## Verification

Source checks ran serially: sandbox-control 402 passed with three skipped, plus
targeted deadline/interactive edge checks; database 51; protocol 164;
API-authorizer 56; acceptance helpers 301 with one skipped; RF3 transport 11.
Real PG checks covered renewal/expiry races, stale/duplicate/future declarations,
wrong resource identity, shared/standalone terminals and indexed work claiming.
Types and applicable documentation, Helm, runtime policy, stock-image,
installation, observability and build-context checks passed.

The maintained matched operator prepared/scanned 14 images, drained writers,
retired old physical allocations and published the recorded candidate. The
four unchanged official Cube images retain only the owner's existing
[ADR-0310 exception](../adr/0310-stock-cube-release-exception.md); all other
images passed their normal gate. Guest templates were unchanged and reused.

### Actual 30-minute window and management outage

A real GPT-6 Luna Run created a Workspace file and then waited on one 100-second
Bash operation. Its activity extended the PG deadline without another Tool.
The native Cube timeout was verified as disabled (`-1`). The test used the
actual 1,800,000 ms policy, not an accelerated replacement.

The recorded deadline was `2026-11-11T11:10:52.827Z`. Resource management was
stopped just before it; the VM was positively observed alive at
`11:11:08.067Z`, after expiry. Restoration retained the same deadline. After
the bounded startup reconciliation grace, physical deletion was confirmed at
`11:13:21.867Z`, followed by PG release. A later Luna Run read the retained file
from a new VM and received the environment-reset notice. Fixture cleanup and
management restoration were confirmed.

This establishes the intended limitation: management/PG or required ordered-
closure downtime can delay physical cleanup. Restart does not reset the
deadline. Startup allows two activity intervals for reconciliation before
claiming due resources. This is not independent provider-side expiry.

### Guest and Worker recovery

Three real Provider/Guest tests passed: two-tenant execution/file/network/PTY
isolation, egress, exact cancellation, uncertain-deletion admission and Guest
restart with original callbacks. All four owned fixture tenants were cleaned.
A direct unmanaged SDK TTL case remains a native contract test, not the managed
expiry policy.

The Worker handoff gate killed the owner during a pending Bash operation and
forced the reachable old-inventory retirement path. Replacement took 18,706 ms.
The same logical Run completed with one start/end pair and execution count one;
the command was not replayed. Physical and fixture cleanup were confirmed.

The small browser/image gate also passed with Luna: Guest Chromium interaction,
canvas validation, screenshot vision, live/cold inline display, retained image
after deleting its Workspace source, and a working public preview link. No npm
installation or large-image upload was needed. Its owned fixtures were removed.

The final preservation check matched 394 original source/image files, both
development-machine intents and account/configuration/credential fingerprints.
The original machines recovered to running; the Android target remained stopped.

## Scope and evidence

This is single-host acceptance, not a fleet-scale or highly available production
claim. No 131 MiB cold model upload was repeated. BoxLite and Android full-provider
integration remains issue #27 and is sequenced after this delivery.

Private reports live under the operator's
`work-evidence/platform-expiry-20261111` directory; raw conversations, credentials
and user files are intentionally excluded from this repository.
