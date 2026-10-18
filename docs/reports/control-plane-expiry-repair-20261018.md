# Control Plane expiry repair and release

Deployed and verified on 2026-10-18 as `control-expiry-c9d8112d`, schema 190.
Decision: [ADR-0259](../adr/0259-control-plane-expiry-progress.md).
Implementation: `4791c658`; final artifact/test-fixture revision: `c9d8112d`.
The Control Plane image is
`sha256:3dbff72689d61c44303ed5bec417df0a0d5e6d0ff6e19968f044104c9bda95f3`.
Kafka execution v17, reply v3, guest 7, completion 3, preview 2 and Cube management
7 are unchanged. [Sanitized evidence](control-plane-expiry-repair-20261018.json)
separates source, artifact, live and cleanup results.

## Result

Session expiry advances past unrelated row locks and already-requested seals.
Persisted failed Workers enter existing retirement even when their management
connection remains live. One expiry no longer visits every healthy Session on its
Worker. PG remains the authority; a successor still waits for ordered Kafka closure.

- Session expiry, management and remote retirement run independently. Short
  maintenance uses three direct-PG connections, with five-second acquisition and
  checkout budgets. Checkout eviction terminates the actual connection.
- Session candidates are SQL-bounded and rotate by lease UUID; connection and
  failed-Worker scans similarly rotate by immutable identity. NOWAIT rolls back
  all earlier candidate locks before continuing. Final identity and PG-time
  checks remain under the existing lifecycle lock order.
- Host/Worker/connection locks protect failure admission. Connection fencing and
  one `worker_failed` retirement commit together. Schema 190 adds that reason and
  partial indexes for active scans; it adds no queue/history table or wire format.
- Normal `work_finished` and ordered seal projection already commit physical
  ownership release with closure evidence. The all-healthy-family prepass is
  removed. Seal/scope updates reuse locked transaction facts, retaining unsealed
  lease rows and exact Run/lease/Fence conditions.

## SQL measurements

| One expired Session among | Business SQL | Including BEGIN/COMMIT | Physical Session lock reads |
| --- | ---: | ---: | ---: |
| 1 Session | 11 | 13 | 1 |
| 8 Sessions | 11 | 13 | 1 |
| 64 Sessions | 11 | 13 | 1 |

These counts cover Session expiry only. An empty Session scan has one query;
connection and failed-Worker maintenance each have their own query. The separate
idle retirement poll has one query plus BEGIN/COMMIT. The former combined scan
cost 28/56 total statements for 1/8 Sessions. Whole idle maintenance now has one
additional business query to discover failed Workers. Counts are client round
trips, not internal trigger statements or a fleet throughput claim.

## Source and artifact verification

- Targeted runs: 61 tests in ten files, then 76 in three files, including real-PG
  locks, full-page deferral, pending seals across eleven Workers, concurrent
  admission, controller restart, lost COMMIT replies and actual socket eviction.
- Workspace coverage totals **1,912 distinct tests** across the initial run and
  focused correction. The initial run has 1,910 passes and one old startup-cleanup
  fixture failure. Its shared pool mock was replaced with separate ordinary,
  maintenance and queue-read pools; all five final acquisition cases pass,
  including the new maintenance-construction failure. This is not a claim that
  the first monolithic CI was green. Runtime code is unchanged by this correction.
- All workspace types, source policies, native/Helm checks, build, formatting,
  documentation and security gates pass. Helpers: **79**; real RF3 transport:
  **9**; fault matrix: **311 cases in 93 groups**.
- The first monolithic CI encounters upstream Cube's temporary-script ETXTBSY
  in its unchanged binary-plugin test. The complete allocation gate passes on
  an unchanged repeat. No test assertion, execution boundary or fallback is relaxed.
- Both initial and final candidates pass eleven artifact scans. Only final
  `c9d8112d` is deployed. The superseded candidate's eleven local image tags are
  removed; its diagnostic evidence is retained privately.

## Live acceptance

All live checks use GPT-6 Luna and owned fixtures:

- Native input: five cases pass, including queue edits/Stop, same-Run Worker
  replacement and simultaneous Worker/Control Plane loss. The browser keeps its
  SSE connection through generation 1 → 2. Stop retains 233 observed characters;
  dual-process recovery retains 175, without PG streaming bodies. Expected
  injection-time kubectl connection loss is backed by container exit 137 evidence.
- Real browser: lost submission reply, Stop, returned image and fresh resend
  identities pass; direct vision and 50 KiB ASCII/Unicode Read boundaries pass.
- Tool images: 6.29/6.29/25.13 MB sources retain 596/596/597-byte canonical reference
  records. A changed Worker Boot correctly recalls the images from durable state.
- Child handoff: compatible Control Plane replacement takes 13,982 ms; the
  original Worker and native child continue, control replies recover and the
  effect occurs once. The first attempt instead ends after a final model HTTP
  500; matching CLIProxyAPI logs show TLS/EOF to `chatgpt.com`, while the Worker
  remains ready. An unchanged fresh-fixture repeat passes. That upstream issue
  is recorded, not claimed fixed.
- Complete Control Plane outage: absent for 63,813 ms, then ready 8,384 ms after
  restoration is requested. Both idle/busy Worker Boots, the active Session lease
  and VM remain unchanged. Both Bash operations execute once; a request retried
  across the outage retains one idempotency identity. The watchdog restore receipt
  confirms the original replica count is restored.
- Full Cube: 22 model requests, five terminal outcomes, 37 native entries and
  172 projected mutations pass. Pure chat activates no VM. Preview/background
  process reuse, a 1,024-file fixture restored onto a fresh VM, rejection of late
  Tool/cancel requests on the deleted VM, and final-conversation release all pass.

## Cleanup and scope

Normal API cleanup and confirmed native absence precede metadata removal.
Three S3 images, four bootstrap-tenant fixture projects/Workspaces and the full-Cube
fixture tenant are removed. Original fingerprints match for all seven checked
account/configuration/credential tables: 32 tenants/users/API credentials, five
password records, 35 model profiles/bindings and zero SCM credentials.

Final PG projects, Workspaces, Sessions, Runs and image rows are zero; native
Volumes, node references, holds and open allocations are zero. Both Workers and
all 28 serving Pods are Ready. Windows and WSL return HTTP 200. Test containers
and the temporary build proxy are gone. No original account/configuration or
credential is discarded.

Production has two Workers. Eleven-Worker fairness and 64-Session SQL evidence
come from isolated real PG; this does not establish fleet capacity or physical-node
HA. Pi continuation, unsafe Tool non-replay, VM destruction authority and provider
retry policy remain unchanged. The next walkthrough hop is ordered seal publication
from the existing Outbox and successor admission, not a newly claimed full audit
of that entire path.
