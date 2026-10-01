# Publication and Cube execution production cutover — 2026-10-01

Status: deployed; real-model, VM, browser and process-failure acceptance passed.
The owner explicitly authorized the shared Cube update and confirmed dsh-cloud
was retired. No further coordination with that project is required.

## Deployed path

Worker → Control Plane publication ingress → RF3 Kafka → Session Projector →
Cube native execution. Cube's trusted host adapter externalizes images and
publishes final replies to the original Worker mailbox. Pi owns native after-tool
processing and the canonical Tool Result. The independent Tool Broker container
is removed. VM lifecycle and resource recovery live in Control Plane.

Migrations 155–159 were applied after proving zero active Runs, leases, unsealed
executions and pending seals. Each Run still executes once; no RunAttempt exists.
PostgreSQL remains authority, and the physical Session remains the Kafka key.

## Preserved data

A private PostgreSQL dump, S3/Workspace archive and configuration backup were
created in the ignored runtime backup directory before mutation. No credentials,
backup contents or conversation transcript are included in this report.

Migration 156 removed 39 already-hidden product Sessions according to the owner's
accepted permanent-deletion policy. All 174 native log rows belonging to the
retained conversation compare identically before and after migration and testing
(MD5 of the ordered complete rows: `510b7a9b51383908184d440802cd5829`). All 17 original
S3 objects, 167,795,857 bytes in total, passed length and SHA-256 retrieval checks
before ordinary reachability-based cleanup resumed.

The previous unknown development VM was retired for the matched guest/runtime
cutover. Its environment and Workspace IDs were preserved; its home Volume was
reused. The final user-owned machine is running with generation 4. Its process
world was replaced during the upgrade, while conversation and Workspace storage
were retained. Acceptance fixtures were separately created and removed.

## Real acceptance

All model calls below used GPT-6 Luna.

| Gate | Evidence |
| --- | --- |
| Three coding Turns | [Native Tools](cube-cutover-native-tools-20261001.json): write/read/edit/Bash, bounded large output and guest symlink semantics. Tool durations 308–537 ms in this sample. |
| Tool image claim check and cold history | [Images](cube-cutover-images-20261001.json): 6.29 MB, 6.29 MB and 25.13 MB images; durable records 778/778/779 bytes. Another Worker correctly recalled the retained visual content. |
| Browser upload | [Uploads](cube-cutover-user-uploads-20261001.json): 1.85 MB image, preview after reload, direct model vision without an image-read Tool, mutable Workspace source changed, and correct cold recovery. |
| Control Plane SIGKILL during native Bash | [Handoff recovery](cube-cutover-handoff-restart-20261001.json): same Run/Worker completed; the shell's start/end markers occurred exactly once. Cube owned execution and final delivery during the outage. |
| Development environment | [Machine acceptance](cube-cutover-development-machine-20261001.json): terminal/SSH/preview, controller restart adoption, pause/resume, shared and temporary Subagents, isolated same-port previews, retained conversation after release, and Volume cleanup. |

The two previously disabled live provider contracts also passed on the upgraded
backend: real VM deletion failure did not falsely release ownership; tenant
isolation, public/private egress, PTY fencing, cancellation, warm background
processes and Volume cleanup passed with zero orphaned fixture VMs.

An intermediate coding-gate repetition encountered one upstream HTTP 500. A fresh
owned test completed all three Turns. No product retry policy was relaxed and no
uncertain Tool operation was automatically replayed.

## Corrections found during the actual cutover

1. Installer Pod selection could race a DaemonSet replacement. It now waits for
   rollout, selects a non-terminating ready Cubelet and retries only the
   read-only configuration retrieval.
2. CubeAPI's authentication callback sends the URI path without its query.
   Observation authorization now follows that contract; CubeAPI validates the
   required node parameter. A positive observation on the recorded node proved
   old VM absence.
3. `kubectl --patch-file=/dev/stdin` could not reopen Node's socket-backed stdin.
   Non-secret Pod patches now use a structured argument; Secret objects still
   use standard-input apply.
4. Existing Redis processes retained old credentials after the Helm Secret
   changed. The installer now uses a credential revision annotation to reconcile
   Redis and its Master/Proxy/lifecycle consumers.
5. Development-machine creation now retains UNKNOWN/quota on uncertain
   allocation or failed cleanup, including the handle/capsule when available.
   Only confirmed absence releases capacity. Three regression cases were added.
6. Cube create/connect `clientID` is a connection UUID; detail/list `clientID`
   identifies the node. The adapter now resolves the actual node from inspection
   before execution/absence requests.
7. Completion routing conflated the native provider call ID and canonical result
   Entry ID. It now carries both: final/error replies keep the native ID, progress
   addresses the Entry ID, and the operation UUID matches the mailbox. Distinct-ID
   tests prevent fixtures from hiding that mistake.
8. The 32-partition native Kafka configuration reached 251 Control Plane threads.
   The old 256 PID cap could prevent health probes from starting. The bounded cap
   is now 1,024, with a deployment-policy check for thread/probe headroom.

Affected component tests, types, installer contracts and runtime-policy checks
passed before deploying each correction. The old control-plane streaming fault
script's direct-Worker-publication assumption was retired. The maintained
control-plane gate now proves Cube handoff continuity; Kafka broker failure keeps
its separate streaming/ISR scenario.

## Final health

[Application health](cube-cutover-service-health-20261001.json) records all 16
running PiCloud services healthy, public API/Web HTTP 200, and no independent
Broker. [Cluster health](cube-cutover-cluster-health-20261001.json) records the
required Cube components at their desired ready counts. The four guest templates
use revision `7af590247250dd60839eae37ecc5baaa5ba596e5`. No active or unsealed
acceptance Run remains, and Cube inventory contains only the restored user machine.
The maintained control-plane restart command was also run successfully after
replacing the obsolete publication-outage assumption.

## Operational limits

This is one WSL/K3s/Compose host, not proof of multi-node availability or
exactly-once external effects. Some old Cube template deletions still time out
against historical node routing metadata; cleanup remained guarded and deferred.
The four current guest templates are READY. This pre-existing cleanup issue stays
in the backlog and does not justify deleting live Volume or template references.
