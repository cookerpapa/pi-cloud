# Guest execution and Session activity delivery

Tracking: [#25](https://github.com/cookerpapa/pi-managed-agents/issues/25),
[ADR-0307](../adr/0307-guest-execution-and-session-activity.md).

Status: matched release `guest-runtime-20261110-r2` (runtime source `4f4dd68e`) is
serving. Real Guest and Provider gates passed; model/recovery/image acceptance
remains in progress. No complete-delivery claim is made yet.

## Implemented behavior

- The Worker outer runtime declares logical resource use through its existing
  fenced physical-Session Kafka writer. Native child Conversations share that
  writer and add their resource references. No VM is created by maintenance.
- Execution uses a bounded resource view and cold resource-metadata reads. The
  periodic Worker/PG-lease join, passive Worker receiver registration and probe
  request HTTP endpoint have been removed. Activity is not native/chat history.
- Full diagnostics are on-demand, with the reply waiter registered before Kafka
  publication. Readiness confirmation remains distinct from retention renewal.
- Fixed Guest SQLite admission and exact operation cancellation replace the
  native Cube execution manager/API. Ordinary envd process/stdin calls carry
  bounded control data; results and images keep their HTTPS/Kafka route.
- A detached operation commits its claim/completion in the same local database,
  independently of the service process. Service restart does not repeat a Tool;
  its cleanup rereads completion after proving the registered launcher exited.
  A lost handoff reply is UNKNOWN, never an invented pre-start refusal.
- Finite elastic expiry no longer consults a busy-Tool veto. Healthy families can
  renew indefinitely; a lost renewal chain may expire even unconfirmed work.
  Dedicated machines remain non-expiring. No missing probe proves VM death.

The matched protocol is Session topic v20, reply topic v4, managed Cube resource
protocol 10, Guest executor control 1 and unchanged Guest Tool payload 7. PG schema
215 does not need a no-op migration for these transport-only changes.

## Serial source verification

| Check | Evidence |
| --- | --- |
| Build and types | Full build/types passed; affected runtime, Guest and provider types rerun after the final implementation refinements |
| Package sweep and corrections | 2,473 tests passed in the broad sweep; five old first-record fixture assertions were corrected, then 103 targeted regressions passed. Three accidentally discovered `.cache/research` suites are not product acceptance |
| Cold data-plane recovery | 65 provider/client tests passed: recover private access from the existing allocation receipt, retain credentials across metadata reads, and never connect/resume during cold probes. Dedicated traffic-triggered auto-resume is disabled to preserve explicit pause intent |
| Updated admission/receiver contracts | 109 tests passed, including removed native API permissions and explicit refusal versus unknown outcomes |
| Real PostgreSQL / Kafka RF3 | 11 transport, fencing, binding, publication and original-reply recovery tests passed |
| Fault manifest | All 409 current cases passed cumulatively; the retired native cancellation test name was replaced with the Guest UNKNOWN case and rerun explicitly |
| Release helpers | 287 passed, one explicitly skipped |
| Native resource contracts | Go race tests with actual Bolt/MySQL allocation, Volume protection and lifecycle history passed; composed Cubelet cleanup/closure compiled and passed |
| Maintained gates | Installer, runtime policy, Helm, observability, image closure and high-severity dependency audit gate passed |

Checks run serially. The short-window Guest live fixture does not claim to measure
the default thirty-minute idle period. The 131 MiB provider upload remains outside
scope. Private raw logs are under `/tmp/pma-0307-*`; no user transcript, credential
or generated private release artifact belongs in Git.

## Resource and Volume assessment

[Pinned source and API comparison](../research/guest-and-resource-boundaries-20261110.md)
covers E2B, Daytona, OpenSandbox, BoxLite and Modal. Provider termination acceptance,
completed termination, and safe Volume deletion are distinct contracts. A closed
provider can supply authoritative lifecycle completion without exposing Cube node
internals, but its actual contract must be tested rather than inferred from a
`delete` method name.

This slice removes native Tool admission/cancellation/probe/completion fallback
code. Allocation close-before-create, physical closure, Volume reference protection,
finite expiry and raw lifecycle history still have native Cube extensions. They
remain until a provider equivalent proves the same required behavior. No alternate
production sandbox was enabled, and the project is not yet zero-patch Cube.

## Publication and live progress

All 14 matched artifacts passed the maintained image policy. The first APT
attempt failed on an HTTP 502 from the configured proxy; the retry used a
build-process `NO_PROXY` exception for Ubuntu's existing signed repositories.
The application proxy configuration was not changed.

The maintained cutover drained writers, retired two old dedicated allocations
with confirmed absence and preserved the existing XFS Workspace pool. Both stable
machines returned to `ready` under their original running intent, with new
allocation identities and unchanged Workspace IDs.

The real Guest gate passed duplicates/changed requests, service SIGKILL during
accepted work, completion while the service was absent, exact Bash cancellation
with process disappearance, survival of completed background work, and explicit
60-second retention expiry while a 120-second Tool was unfinished. Every owned
allocation was closed and confirmed absent. This uses the deployed, unmodified
Guest image.

The native Provider gate passed two-tenant isolation, public access/private-route
boundaries, cancellation, warm background survival and physical cleanup. Sample
complete-Tool durations were 406 ms and 402 ms; these are fixture measurements,
not a latency guarantee. Its stale pre-quota fixtures were updated to register
real Workspace intent and use the normal Workspace deletion API. The original
helper omitted completion ingress and used a non-mounted `/workspace`; the Guest
control fixture now uses an explicit owned subdirectory and the deployed callback
address. Failed fixtures were not counted as acceptance.

Publication also exposed a stopped egress gateway: Kubernetes considers rollout
of zero replicas successful. The gateway was restored to the declared singleton,
and the operator now verifies replicas, availability, observed generation and
image after reconciliation. Two regression cases cover this failure. Runtime
images remain the matched r2 artifacts; these follow-up changes are operator/tests.

Private evidence: `/tmp/pma-0307-live-guest-fixed.log`,
`/tmp/pma-0307-live-provider-online.log`, and the matched candidate under
`~/.local/share/pi-cloud/releases/guest-runtime-20261110-r2`.
