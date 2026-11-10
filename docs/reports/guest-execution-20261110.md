# Guest execution and Session activity delivery

Tracking: [#25](https://github.com/cookerpapa/pi-managed-agents/issues/25),
[ADR-0307](../adr/0307-guest-execution-and-session-activity.md).

Status: matched release `guest-runtime-20261110-r3` (runtime source `1e559243`,
Helm 158) is serving. Serial source checks and real Guest, Provider, Luna, Worker
recovery, images, Session activity and VM-loss acceptance passed. The final
combined callback-loss/recovery run also passed and confirmed physical cleanup.
Operator and fault-fixture follow-ups are pushed through `8d8af3a1`; they do not
change the deployed application or Guest images.

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
| Fault manifest | The 409 initial cases passed cumulatively; the retired native cancellation test name was replaced with the Guest UNKNOWN case and rerun explicitly. The later native recovery binding regression passed, bringing the manifest to 410 |
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

Cold provider connection bootstrap also still uses the retained allocation
receipt API. The runtime patch covers 73 paths and the dependency/build patch 14;
these counts include tests and generated protobuf. Removing Tool-specific APIs
does not make stock Cube a drop-in replacement for the entire integration.

## Publication and live acceptance

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
image after reconciliation. Two regression cases cover this failure. The r3
matched cutover includes the recovery correction below; the gateway and fault
fixture changes are operator/test code.

Private evidence: `/tmp/pma-0307-live-guest-fixed.log`,
`/tmp/pma-0307-live-provider-online.log`, and the matched candidate under
`~/.local/share/pi-cloud/releases/guest-runtime-20261110-r3`.

## VM-loss continuation follow-up

The r2 fault run passed lost-result inspection, lost result/probe holding, repeated
HTTP completion after a lost ACK (two deliveries / one execution), preserved
background work and browser restoration of UNKNOWN. VM loss exposed a recovery
address race: resource cleanup removed the old closed binding, then a retry used
the same logical ID to prepare a fresh VM. The ordered view refused to reopen
that identity and the native Run remained waiting. Failed fixtures were cancelled,
physically cleaned and their acceptance tenants purged.

The Worker now chooses one fresh logical binding when recovery still references
its current failed binding, retains it across retries, and ignores withdrawal for
an older address. Operation identity/target/reply deadline do not change; no Tool
is replayed. A native Harness regression seeds that pending recovery and verifies
two readiness attempts use the same new ID without Tool activation. Relevant
Worker/Harness suites pass 415 tests and the new fault case passes; the manifest
now contains 410 cases. The correction is deployed in r3. Its standalone VM-loss
acceptance passed: the original Run continued, the command occurred once, and the
environment reset was recorded before continuation. Its test resources were
physically removed and its disposable tenant purged.

The combined follow-up initially exposed an obsolete fault fixture: suppressed
probes were matched only to the old logical binding. Recovery's fresh address
therefore received a real readiness response and correctly continued. The fixture
now also matches the exact owned VM, executor boot and reply destination, with
regression assertions that unrelated probes pass through. The test does not alter
production probe admission or claim that a missing reply proves VM death.
The final combined run passed with that corrected fixture.

## Additional live acceptance

All checks use the deployed stack and run serially. Real model cases use GPT-6
Luna. Cases on r2 verify the same Guest/provider code retained in r3; the recovery
correction is additionally verified on r3.

| Check | Observed result |
| --- | --- |
| Production conversation and tools | 19 model requests, five terminal Turns and 31 canonical entries; pure chat created no VM; Tools, authenticated preview and background survival passed |
| Workspace continuity | 1,024 files survived a new VM on the same persistent Volume; deleted-Guest tool, cancellation and identity requests were rejected |
| Worker SIGKILL | The same logical Run resumed on a replacement Worker in about 18.8 seconds; the original command executed once and its original reply was received |
| Activity and diagnostics | Session activity continued during a silent 100-second Bash; a direct probe took about 203 ms; old boot was rejected, unavailable callback remained unconfirmed and a paused VM stayed paused |
| Retention observation | Fourteen confirmed default-policy renewals were sampled; an unconfirmed renewal during fault/closure did not establish physical absence |
| Images | About 6.29 MB, 6.29 MB and 25.13 MB objects used 596–597-byte Kafka reference records; a cold replacement Worker recalled the retained image correctly |
| VM loss, r3 | Original Run completed after a verified replacement; one original command and a recorded environment reset |
| Lost result | One command; its native result settled UNKNOWN, a fresh successful probe permitted continuation, and the Agent inspected the file instead of rerunning the command |
| Lost result and probes | Three probe replies were suppressed, including recovery's new logical binding; the Run kept an interruptible wait and Stop settled it; no subsequent Tool ran |
| Lost completion ACK | Two callback deliveries represented one execution; the completed background process survived |
| History and combined recovery | Both canonical history and a fresh browser restored UNKNOWN; the same Session subsequently recovered from VM loss without repeating its original command |

Temporary owned compute was closed through normal resource APIs and confirmed
absent. The original two dedicated machines are `ready` with `running` intent,
unchanged Workspace identities and preserved XFS storage. These are local
integration measurements, not fleet-scale availability or latency guarantees.

After all live work settled, the remaining production-check tenant was purged
only after Workspace physical cleanup and source receipt delivery. Retired Session
topics v17 and v19 were removed after fresh checks found no unsealed Runs or
protected replay references; the deployed v20 topic and all reply destinations
were preserved.

Private final evidence: `/tmp/pma-0307-final-continuation-rerun.json` records
`accepted: true`, restored completion deployment, verified environment reset,
browser/canonical history restoration and `cleanupConfirmed: true`. Related
reports are `/tmp/pma-0307-worker-recovery.json`,
`/tmp/pma-0307-activity-probe.json`, `/tmp/pma-0307-images.json` and
`/tmp/pma-0307-vm-final.json`. Raw evidence remains outside Git.
