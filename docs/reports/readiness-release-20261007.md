# Readiness release: pilot-ready-81392f7d

Deployed on October 7, 2026 from clean source
`81392f7d012b6f5bee16402ec94e33050001c426`, using the maintained
[matched release procedure](../MATCHED_RELEASE.md). The owner authorized rollout
and declined backups of the current disposable data. No backup or business-data
reset was performed. The private-use pilot itself has not started.

[Machine-readable evidence](readiness-release-20261007.json) records artifact
identities and bounded results. Full private build/scan/acceptance evidence is in
`dist/releases/pilot-ready-81392f7d/`; credentials and native history are not
included in the committed report.

## Cutover

Preparation ran with `umask 077`, without modifying serving image catalogs or
templates. Seven application and three native images were built for this release;
the exact registered guest digest was reused and scanned. All eleven images pass
the zero-fixable-HIGH/CRITICAL gate, and npm audit reports no vulnerabilities.
Installer, Helm, documentation and source checks pass.

After a complete 1/1-node inventory confirmed no VM, the maintained command
drained application writers and reconciled Cube, guest templates and the platform.
Helm revisions are Cube 59, infrastructure 29 and platform 30. The Control Plane,
two Workers and native Cube services run the new image tag. HTTP health is 200
and all 32 publication partitions are available. Schema 182, Pi Durable 1.0.0,
guest/Tool Worker protocol 4 and Cube management protocol 7 remain unchanged.

## Acceptance and corrections

The full GPT-6 Luna production check passes with 21 provider requests: pure chat
without VM activation, multi-round coding on a warm VM, authenticated preview,
background-process survival, tenant isolation and 1,024 generated fixture files
surviving source-VM removal and attachment to a fresh VM. Two native provider
cases pass isolation, egress policy, cancellation, refused unconfirmed cleanup,
Volume cleanup and zero owned VM orphans. The temporary proxy configuration is
restored to its original disabled/unconfigured value.

The browser driver exposed two errors in its own verification/cleanup logic:
it waited for every attachment card on the page to disappear, although the queued
message must retain its image; and it cancelled a sibling using a stale snapshot
after Stop had already withdrawn that input. The driver now scopes removal to the
composer and deliberately waits for both attachment regions first. Cleanup reads
fresh Run state and uses the revision-checked queue API for unstarted work. Two
new regression cases pass, along with the five existing operator-fixture cases.
These changes are operator scripts, outside the deployed runtime image closures.

A subsequent Read check failed because CLIProxyAPI's upstream TLS handshake ended
with EOF. Its canonical failure was recovered from the owned Session's Kafka
partition, using a temporary read-only diagnostic consumer without committing
offsets. The driver now captures bounded model-failure diagnostics before removing
its fixture. A fresh, separate run passes the whole browser matrix: lost response,
Stop, restored text/image, distinct resubmission identity, direct vision, and
ASCII/UTF-8 Read prefixes with canonical truncation diagnostics. No provider
failure or uncertain Tool effect was relabelled successful or silently replayed.

## Final state

All owned acceptance Sessions, Runs, Workspaces, VMs, Volumes and images are removed.
The full production driver's isolated account and three physically purged Workspace
metadata records were also removed by their recorded IDs, preserving the foreign
account used for its isolation check. One pre-existing orphan image had no tenant,
Run, native reference or upload claim and was removed separately. Twenty-one
retired Docker/K3s image tags were removed after verifying no live workload used
them; the registered guest and shared infrastructure images remain.

The original 29 accounts/tenants and 30 model profiles remain. Configuration
fingerprints match before/after, excluding documented access timestamps, workspace
counters and the audited proxy-fixture revision/actor fields. Final counts are
zero Sessions, Runs, Workspaces, projects, pending controls, image objects, active
workspace runtimes, execution writers, native VMs and native Volumes.

The earlier [readiness record](private-readiness-repair-20261007.md) remains the
source-stage evidence; its then-unperformed matched cutover is now exercised.
Fresh-machine installation, physical-node HA, large-history recovery time and
actual pilot usefulness remain separate claims. R07R3-04 stays owner-deferred.
