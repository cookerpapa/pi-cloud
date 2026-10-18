# Session lease repair and delivery

Date: 2026-10-18. Decision: [ADR-0258](../adr/0258-bounded-session-lease-renewal.md).
Review baseline: `ddc404f8`. Status: **implemented, verified and deployed** as
`session-lease-079dbddc`. Artifact and live-test source:
`079dbddc7c3c523de68c276adf7a7bb8d803fef6`.
Actual Control Plane image:
`sha256:2160f871f6129ade973cd48386de6619b0ac86f25905441e09389ac113eeb0fe`.
All required checks, relevant live acceptance and owned fixture cleanup are complete.

## Changes

- WLR-01: the shared observer enforces active deadlines independently of reads,
  including synchronous checks after event-loop delay. Pending callers receive
  abort; close does not wait for PG. Fresh cold authorization remains required.
  A dedicated two-connection Worker lease pool bounds acquisition and complete
  checkouts to five seconds each, including COMMIT, and destroys failed sockets.
- WLR-02: fatal renewal failure disables local claims and revokes executions
  before bounded PG quarantine. Diagnostics cannot suppress that revocation.
- WLR-03: available lease rows renew in one batch while eligible busy rows are
  explicitly deferred. Deferral never extends a local lifetime. Both consumers
  validate identities and disjoint outcomes; batch retry is at most one second.
  Expired, closed, failed and mismatched owners still cannot renew.

Normal nonempty renewal remains three business SQL statements plus BEGIN/COMMIT.
There is no new authority service, PG table, Kafka record or compatibility decoder.
Only the private heartbeat acknowledgement requires a matched schema replacement.
The former review-only probes are retained in Git at `ddc404f8`, replaced in the
working tree by maintained observer, database and real-PG renewal regressions.

## Verification and release

Required gates pass in two recorded stages. The first full CI command passes
native Cube admission/allocation, installer, Helm, runtime policy, observability,
image closure and build, then fails the type boundary described below. After the
type correction, formatting, docs, build, all workspace types/tests, helper tests,
RF3 transport, fault evaluation and security audit pass with exit code zero.
This is not a claim that the first monolithic CI command passed.

- **1,897 workspace tests**, across 22 package groups; existing opt-in skips remain.
- **79** acceptance helper tests, **9** real RF3/PG transport tests.
- **302/302** fault cases across 92 groups, at clean source `079dbddc`; p50 target
  assertion time 55 ms, p95 6,036 ms. This is deterministic fault injection, not
  live multi-node chaos or a fleet capacity measurement.
- Real-browser presentation passes, including observation generation recovery.
- All **11** final matched artifacts pass the unchanged vulnerability gate;
  package security audit reports no remaining vulnerabilities. Unfixed image
  findings remain visible in scan evidence; no exception or threshold relaxation.

Final artifact preparation/preflight and matched apply pass. KVM device checks,
writer draining and quiescence precede native/application cutover. The guest
identity remains `5d775367299e1cfc7877a2bf2544f857f4690f08`; the exact reused image
is scanned and registered without a post-scan rebuild. Earlier candidates for
`4b2cc339` and `b5f30872` passed scans but were **never deployed**.

Schema 189, execution topic v17, boot reply v3, guest/Tool Worker 7, completion 3,
preview 2 and Cube management 7 remain. The required private heartbeat deferral
array is deployed on Worker and Control Plane together, with no old-message decoder.

## Live acceptance

All cases use GPT-6 Luna and owned fixtures on the supported single-node K3s host.

| Check | Result |
| --- | --- |
| Native input, edit/retry and Stop | Five cases accepted; one logical Run, durable queue edits and no retained edit bodies. Worker crash exits 137; same SSE accepts generation 1 → 2, activity revision 1 and confirmed execution revision 5. |
| Native streaming recovery | Stop preserves 283 observed characters; combined Worker/Control Plane SIGKILL preserves 216. Both crash exits are independently confirmed as 137; no PG streaming bodies. |
| Browser/upload/Read | Lost response, Stop and returned-image resend use fresh admission identities and direct vision. ASCII 120,017 → 51,200 bytes; Unicode 140,031 → 51,196 valid UTF-8 bytes with canonical diagnostics. |
| Image transport and cold context | Successful repeat transfers 6,294,271 / 6,294,639 / 25,128,841-byte images; canonical records are 596 / 596 / 597 bytes. A different Worker Boot correctly recalls all three after the source path was overwritten. |
| Native child across Control Plane replacement | Compatible same-artifact rolling replacement takes 12,860 ms; original Worker stays, the control Tool reply recovers and the fixture effect count is one. |
| Complete Control Plane outage | All CP replicas are absent for 64,722 ms. PG renewals advance at 10:16:55.473 and 10:17:15.477 UTC while projection stays at sequence 10; Kafka retains 28 records including a Tool result. The same Run/lease/VM survives, both idle and busy Worker Boots stay, and repeated intake creates one Run. Restore-to-ready is 9,335 ms; management re-registration follows. |
| Full Cube suite | Accepted on the actual image: 20 model requests, five terminal Turns, 34 native entries, 35,051 canonical bytes and 171 projected native commits. Pure chat activates no VM; warm reuse, authenticated preview, background process survival, fresh-VM persistent Volume restoration (1,025 → 1,026 files), tenant isolation and last-conversation release pass. Removed VMs reject both Tool and cancellation admission. |

The first image attempt passed all three image replies but its cold recall Run
received upstream HTTP 500. The corresponding CLIProxyAPI log identifies a TLS
EOF to `chatgpt.com` at 10:07:42 UTC. No lease-revocation error was observed.
The failed report/filtered diagnostics and physical cleanup proof are retained;
an unchanged full repeat in a new owned Session passes. This does not establish
that the pre-existing upstream TLS instability is fixed, and no timeout or model
assertion was relaxed. No proxy-node change was required for this successful repeat.

The intentional dual-process crash also prints kubectl's `container not found`
while the Control Plane is restarting. Separate kubelet termination/restart
evidence confirms the requested SIGKILL; the maintained driver accepts the case.

Live acceptance verifies control-independent renewal. It does not inject a live
PG-cluster outage/failover, establish physical-node HA, or prove arbitrary mixed
schema upgrades. PG errors retain the existing conservative local-stop policy;
local expiration still cannot release ownership or replace ordered Kafka closure.

## Cleanup and preserved configuration

At 10:26 UTC, all original seven configuration-table fingerprints match the
pre-release baseline: 32 tenants/users/API credentials, five password credentials,
35 model profiles and credential bindings, zero SCM credentials. As in earlier
checks, API credential last-use time is excluded; credential/configuration content
is compared. Runtime Boot credentials follow their normal replacement lifecycle.

Normal API cleanup and positive native absence precede the guarded removal of
the one full-Cube fixture tenant, four exact bootstrap fixture projects/Workspaces
(two image attempts, child, foreign-tenant check) and six exact image objects.
Projects, Workspaces, Sessions, Runs, uploads, image objects/references, active
writers, bindings, runtimes, terminals and unpublished controls are zero. Native
Volumes/node references/holders and open or non-absent allocations are zero;
recorded-node inventory is 1/1 with no VM. **28 Pods are Ready**, Windows and WSL
return HTTP 200, and temporary build proxy/test containers are absent.

Private evidence: `deploy/production/runtime/release-evidence/session-lease-20261018/`.
[Sanitized evidence](session-lease-repair-20261018.json) records source hashes,
results and the evidence boundary without credentials or transcripts.

## Retained implementation failures and corrections

The first targeted run passes 69 tests across six files. The initial transport
budget run passes 40 of 41 tests; its pool fixture incorrectly required an already
waiting acquirer to survive its own timeout while the expired socket closed.
The corrected fixture accepts that bounded refusal, then independently verifies
old backend disappearance, rollback and a new working connection while the old
transaction callback is still held. All four checkout cases pass on that repeat.
No production timeout was widened. A later source inspection also makes idle
socket destruction explicit; the final checkout tests and repository gates
verify that implementation.

The first workspace typecheck finds an unused variable in the revised grant
lock-wait fixture. Removing it makes all five affected workspace typechecks pass.
The renewal lock case now tests nonblocking deferral plus positive rejection after
expiry, rather than expecting renewal to wait for the held lock. Grant admission
still tests post-wait expiry. The real TCP lost-COMMIT test confirms exactly one
fixture insert, rejection of the unconfirmed return and no automatic replay.

During the full CI run, before its fault stage, inspection found that the new
lock-isolation matrix entry used a prefix while the evaluator requires an exact
parameterized title. It is corrected to the `expire A=true` case; the ordinary
suite still runs both early-unlock and expired cases. This changes only the matrix
and this record, not runtime or test assertions. The completed first candidate
for `4b2cc339` was not deployed. Formatting/documentation checks were repeated for
that correction while the unchanged runtime CI stages continue.

That first full CI run passes native admission/allocation, Helm, policy,
observability, closure and build gates, then stops at workspace types: the late
explicit socket-destruction call accesses `connection`, present on pinned pg's
actual Client but omitted from its PoolClient declaration. A local intersection
with `Pick<Client, "connection">` makes the adapter boundary explicit without
changing emitted JavaScript. Corrected formatting/docs/build/workspace checks,
transport/fault/security gates and a newly scanned matched candidate all pass
before deployment. Neither earlier passing candidate was deployed.
