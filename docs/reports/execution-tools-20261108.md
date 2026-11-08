# Execution-owned tools and independent publication

Issues [#12](https://github.com/cookerpapa/pi-cloud/issues/12)–
[#16](https://github.com/cookerpapa/pi-cloud/issues/16), governed by
[ADR-0305](../adr/0305-execution-owned-tools-and-bindings.md).
Delivered on 2026-11-08. Source implementation, publication and the final serial
execution, recovery, image and child acceptance passed.

## Serving combination

The base matched release is `execution-tools-20261108-r1`, source `8e74f5c0`,
schema `214_execution_binding_admission`, infrastructure Helm 116. The final
application release is Helm 151, with independently recorded role provenance:

| Role | Image publication | Source |
| --- | --- | --- |
| Management, Worker, other matched components | `execution-tools-20261108-r1` | `8e74f5c0` |
| Session runtime | `session-decoder-20261108-r1` | `63c9b54c` |
| Ordinary Tool host | `tool-host-20261108-r2` | `e4bcccde` |

The matched fourteen-image gate and each subsequent one-image gate passed.
Operator fixes retain the original artifact/scan identities; a later operator
revision is never represented as a rebuild. Accounts, provider/model settings and
credentials were not cleared. Existing compute was retired through the maintained
matched procedure while stable machine intent and Workspace bytes were retained.

## Result

| Issue | Implemented behavior |
| --- | --- |
| #12 | Generic Worker Tool proxies use the public Pi hooks and Storage interface. Native checkpoint interpretation is concentrated in a private adapter. The final validated intent and dispatch remain one Kafka commit. |
| #13 | Worker supplies a logical Workspace/compute target. The execution owner prepares and observes its immutable binding; management owns physical VM/Volume admission and recovery. Pending preparation does not block later Kafka binding/closure records. |
| #14 | `SandboxToolExecutor` owns the whole-tool submit/cancel boundary. Cube payload construction, physical identities and transport failure classification stay in the Cube adapter. |
| #15 | Pinned BoxLite source/license/capability assessment plus an isolated KVM experiment. BoxLite is not installed as a production fallback or second backend. |
| #16 | Ordinary handlers run in an independent `tool-host`. Versioned full catalogs reach every Worker through a compacted Kafka topic. Ordinary Tool publication preserves Session API/Projector, Worker and VM processes. |

The resource-read API separates Workspace, stable development machine and current
binding. A routing binding being open/closed is not a statement about physical VM
health. Cold administrative reads retain PG authority; bound Tool/data calls use
the execution owner's recovered view and frozen assignment.

Physical retirement closes PG admission, publishes the binding change, and waits
for the existing Outbox's application acknowledgement before contacting Cube.
This acknowledgement proves stopped dispatch admission, not process death. Late
binding creation rechecks the closed writer gate. Confirmed physical absence is
still required before allocation release.

Cube orders a VM's calls per Kafka partition, including different bindings that
share that VM. The implementation now serializes those short handoffs and
cancellations consistently. Separate resources may prepare independently. These
queues do not wait for Bash lifetime, allocate another durable scheduler, or replay
an uncertain external effect.

## Evaluation decisions

**Keep same-commit native intent and dispatch.** Pi Durable commits the running
Tool checkpoint before invoking its public `execute`. Publishing from `execute`
is valid, but adds another commit and a gap between durable native intent and
remote dispatch. The selected proxy prepares its waiter and logical environment
before that original commit, then awaits the original callback. Contract tests
compare zero extra dispatch commits with one extra commit for execute publication.
There is no Pi-core patch, second producer or operation ledger. Some pinned-native
format knowledge remains in one private tested adapter; this is an intentional
coupling, not a claim that it was completely removed.

**Keep Cubelet completion ownership.** A generic HTTP caller waiting for stdout
would make completion depend on that caller surviving. A replacement provider
needs retained execution IDs/results or a separately justified receiver with the
same lost-ACK and cancellation contracts. This release isolates Cube mechanics;
it does not claim every closed-source sandbox is already interchangeable.

**Defer BoxLite as a production backend.** With Python SDK 0.12.0 and its pinned
OCI image, abrupt caller exit left the Box stopped; the old execution handle was
invalid. The external file effect remained once. A new explicit execution clipped
200,000 characters to a 51,235-byte JSON response at source. A persistent-root
marker survived stop/restart. Both isolated probes removed their own Boxes.
The first `/tmp` marker test failed and is retained. These are configuration-specific
observations, not a speed comparison or proof about every detached Runner mode.
The core Apache-2.0 license and AGPL-3.0 cloud applications are distinguished in
[the source study](../research/execution-boundaries-20261108.md).

## Serial verification

Implementation preceded combined tests. Heavy suites, image builds and live
fixtures ran serially. Relevant regressions were rerun after findings instead of
repeating unrelated suites.

- The initial 24-workspace run recorded 2,447 passes, five failures and twelve
  skips. The failures were stale SQL/schema/mock/native-task expectations; their
  corrected targeted run passed nineteen tests. The initial failure logs remain.
- Isolated real RF=3 Kafka and PG integration passed ten tests across nine files,
  including catalog broadcast, cold bootstrap and stale initialized publisher
  rejection. Shared-VM handoff/cancellation regressions passed.
- The fault run passed 388 of 391 entries. Three outdated selector names were
  corrected and passed targeted reruns; the coverage record matches all 391
  current entries. This is not reported as one entirely green original run.
- Native Cube admission/allocation, workspace types/build, Helm/install,
  documentation, runtime policy, dependency and image checks passed.
- Decoder repair passed 67 focused tests. Tool-host preparation passed 189 tests,
  including actual PG-backed contracts; the route correction also has exact
  manifest and caller-connectivity regressions.

| Live check | Observed result |
| --- | --- |
| Independent Tool publication | 33,739 ms replacement while an original Bash waited in Cube. 109 Session API reads succeeded (maximum 15 ms in this sample), and a follow-up was durably admitted. Worker boots, lease/fencing identity, VM, other Pods and existing machines were unchanged. |
| Next request's directory | The same Run saw the changed Preview definition, completed its original Bash once and successfully called Preview. Physical fixture cleanup passed. |
| Pure chat | Completed with zero Tool calls and zero VM activation. |
| Coding and preview | Actual file/Bash work, authenticated preview access and cross-Run VM reuse passed. The detached background process remained alive across bindings. |
| Workspace recovery | A 1,024-file fixture survived original VM removal and attachment to a new VM. The deleted VM rejected both old Tool and cancellation admission. Final-conversation cleanup released the unused elastic runtime. |
| Native input and recovery | Five cases passed: queue consumption/edit identity, Stop, Worker SIGKILL, streaming Stop, and Worker plus Session-runtime SIGKILL. One logical Run, retained partial text, no PG streaming bodies and fixture cleanup were verified. |
| Image input and retained results | Edited image-only input was promoted to steer and consumed once in the same Run, without a read Tool. Two 6.3 MB and one 25.1 MB retained images used 596–597-byte native references; replacement-Worker visual recall and cleanup passed. |
| Child Conversations | Thirteen live turns covered no-compute/lazy-compute, shared and isolated execution, parallel worktrees and coding, nested ownership, native messaging, parent decisions and cancellation. Guest execution and product tree projection passed; cleanup completed. |

## Findings preserved from failed attempts

1. A shared-VM submission/cancellation could overtake an earlier preparation on
   another binding. The before-fix ordering regression failed and the corrected
   handoff tests passed; Kafka consumption stays independent of preparation.
2. Matched artifact verification initially omitted `toolHost` from its strict key
   list. The operator now verifies all independent roles against the one shared
   artifact without requiring four builds.
3. Native Cube Pod readiness preceded fresh node discovery. A bounded read-only
   gate now requires current Pod identity and fresh native ready/health observations
   before template creation. No uncertain create is automatically retried.
4. The Session envelope decoder rejected new logical-environment and implementation
   fields. A full encode/decode regression reproduces it; the exact declared fields
   are now accepted and validated. A scoped Session-runtime repair retained Kafka
   positions. The original blocked invocation had already timed out and its lease
   expired before the repair; it settled as timed out, not successful or replayed.
   Its expired Worker restarted after re-registration was rejected. This sample
   does not claim a fresh active Worker survived that repair.
5. Session-runtime egress omitted Tool-host TCP 4310. Readiness and operator-side
   activation passed, while the real caller received connection refusal and Tools
   returned UNKNOWN. The Helm rule now names the same-release Tool-host Pods, and
   the publisher checks authenticated reachability from actual Session Pods.
   The subsequent preview and independent-publication acceptances passed.

The initial upload-queue fixture received HTTP 409. Holding its Bash open still
reproduced the conflict, so a too-short sleep was not sufficient to explain it.
The fixture had read a potentially old PG-backed queue immediately after Kafka
acceptance. It now waits for that acknowledged input to appear before editing,
and holds the Tool boundary until both mutations commit. Product revision and
consumption checks are unchanged; the original failed attempts remain.

The bounded publication scopes preserve full-manifest validation. They do not
permit arbitrary chart/ownership changes, skip malformed Kafka records, reset
consumption, or weaken fencing to make a release pass. Proxy/WSL interop failures
and the initial live failures remain in the private operator evidence.

## Limits

Evidence belongs to this single-host K3s environment, not fleet HA or a throughput
SLA. Ordinary Tool replacement waits for accepted ordinary handlers to settle;
new calls may receive an explicit unavailable result during that drain. It does
not wait for an entire Agent Run or stop an unrelated native Bash.

New VM activation and physical lifecycle still require management. Existing
bindings, projection and canonical Tool settlement retain their separate roles.
Arbitrary shell/external effects are not exactly once. Lost uncertain replies are
not silently reissued. The previously deferred 131 MiB cold model upload was not
rerun; no unlimited provider upload claim is made.

Final PG/runtime reconciliation found no active Runs or Session leases, two ready
Workers, no unpurged owned test Workspaces and no unready running Pods. Both
original dedicated-machine identities remained ready with their original
Workspace selection and running intent.

Raw evidence is private under
`deploy/production/runtime/work-evidence/tool-boundaries-20261108/` and the named
release candidates. Credentials, transcripts and generated fixture data are not
included in Git. PG maintenance/HA Issue #11 is separate from this delivery.
