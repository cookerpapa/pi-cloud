# Model response and Agent lifetime repair

Status: deployed as `model-runtime-058925bb`, schema 192, on 2026-10-20.
Clean artifact source: `058925bb2036e8ea9dd8f906c631961b0fee1787`.
Required source/artifact and live acceptance pass, including real work beyond
the removed deadlines and graceful Worker handoff. Physical cleanup and original
configuration preservation are confirmed. A failed first child-recovery sample
and its cause remain explicitly recorded below.

Decision: [ADR-0263](../adr/0263-model-response-and-work-lifetimes.md).
Scope: owner-approved [repair plan](model-request-response-repair-plan-20261019.md),
including removal of the overall Run duration limit.

## Source changes

- Delete the Runner timer, duration policy column and private duration fields.
  Model grants follow current Run/Conversation ownership and Worker boot rather
  than a separate TTL. Revocation interrupts requests before unrelated cleanup.
- Worker shutdown allows 30 seconds of natural drain, then closes admission to
  late claims and uses existing ownership retirement/same-Run recovery. Retirement
  is bounded independently at 660 seconds; process cleanup has its own final
  bound. Unconfirmed settlement never becomes an owner-exit proof.
- Pi's public parsed provider events and normalized model events now meet in one
  request-local Models adapter. The old Gateway SSE interpreter, phase maps and
  hosted transcript/activity subscription plumbing are removed.
- Early text phases follow stable provider/native slot mappings. Completed hosted
  items use empty native text slots with PiCloud metadata; no visible text or local
  Tool call is fabricated. The exact-model payload hook replaces their owned
  placeholders with provider-native items in their original positions. Other-model
  context excludes those carriers. Incomplete local calls remain private.
- Gateway errors retain native retry classification. The Models port preserves
  known HTTP/provider transient meaning while respecting Pi's terminal quota and
  billing exclusions. Durable remains the only sampling retry owner.
- Semantic model execution and HTTP transport have separate metrics. Native
  terminal success before EOF remains successful; transport disconnect is still
  recorded. Parsed-event timing is correlated with HTTP timing using the existing
  sampling identity and same-process monotonic clocks.

Native commit/abort semantics are unchanged. Completed hosted metadata survives
an acknowledged partial and ordered handoff; events not yet committed have no
stronger durability promise. Pi 1.0 retains aborted/error Assistant entries as
history but excludes them from later model context; this repair does not override
that rule or make late output replace native abort.

## Source verification

Focused tests cover both real native provider adapters over loopback HTTP,
native transient retry and terminal billing/configuration errors, phase mapping,
hosted-only Stop/cold reopen, exact payload replay, and semantic success before EOF.
Real-PG cases verify no in-flight hosted bodies in retained PG history, canonical
aborted search reconstruction, and ordered checkpoint/reopening with the original
Submission. Their publisher projects synchronously in the fixture; they do not
claim real Kafka failover or a live provider.

A controlled one-hour wait in the Runner's model admission path completes without
the old total timer. A model grant remains valid across a controlled 24-hour wall
clock change and is rejected immediately after owner revocation. Separate tests
cover bounded retirement, unavailable settlement and a late claim after retirement.
These do not replace the required real Run crossing both old time thresholds.

Initial fixture corrections included a removed-export import, a schema-count
expectation, and the PG fixture's missing replay position, native TEXT Session ID
cast and Storage close Context argument. Private failures are retained; they are
not presented as production defects or silently counted as passing checks.

The first full CI attempt also exposed obsolete startup-test configuration:
its mocked config omitted the two new retirement fields, causing a NaN deadline
and three uncaught timer errors despite passing assertions. The fixture now uses
the real bounds and controls failure-path timers; it also verifies the hard exit
remains armed after cleanup errors. All 85 Supervisor tests and its typecheck pass
after correction. The other 1,891 workspace tests passed in the original run;
11 environment-gated cases were skipped. The remaining CI stages are run separately,
not reported as an uninterrupted green `npm run ci` invocation.

Repository formatting/documentation, install/runtime policy, native Cube contracts,
Helm/observability/image closure, build and typechecks pass. All 1,976 workspace
assertions pass after the fixture correction above; 80 acceptance-helper tests,
nine isolated real RF3/PG transport tests and all 361 fault cases pass. The dependency
audit reports no remaining vulnerabilities. The quota-classification follow-up
also passed 34 targeted tests; final whole-workspace/fault runs include it.
These source checks ran before the implementation commit; the generated fault
report truthfully records its then-dirty source base. Release artifacts were built
from the clean implementation commit above. All 11 provenance/SBOM/vulnerability
checks pass, with zero fixable HIGH/CRITICAL findings under the maintained policy.

## Deployment and live acceptance

The maintained release procedure confirmed working KVM, zero active writers and
native VMs, drained the applications and applied schema 192. Helm revision 62
completed; unchanged guest inputs reused the exact registered image. Kafka topic
v17, boot reply v3, guest/Tool protocol 7, completion startup 3, preview schema 2
and Cube management 7 remain unchanged. No compatibility reader or fallback was
introduced. Existing business data was already empty; account/provider/model
configuration was preserved.

All real-model gates use GPT-6 Luna:

| Gate | Observed result |
| --- | --- |
| No total Run deadline | One Run lasts 1,000.231 seconds; nine model requests span 993.002 seconds in one Worker process, with zero recovery transitions. Four sequential Tool effects and four native queued inputs complete. |
| Graceful Worker handoff | During a Tool and pending follow-up, SIGTERM retires the original Worker in 32.464 seconds with exit code 0. One recovery resumes the same Run, consumes the follow-up and preserves one physical append. |
| Hosted search and replay | One real completed search persists as native empty-text metadata, renders canonically and replays successfully into the next same-provider Run. No local Tool or Cube activation. |
| Native input | All five consumption, Stop, Worker recovery, stream Stop and simultaneous Worker/Control Plane crash cases pass. Partial text survives, streaming bodies remain out of PG, and the browser accepts the newer execution generation on its existing SSE connection. |
| Browser/upload/Read | Lost admission reply, returned queued image, fresh resend identity, direct vision and native 50 KiB ASCII/UTF-8 Read boundaries pass. |
| Child Worker recovery | The unchanged repeat preserves one original child, Submission and configuration hash, with one physical append and no child cloud Run. See the first failed sample below. |
| Child across Control Plane replacement | Replacement takes 15.795 seconds; the same Worker completes the native child/control reply, with one physical execution. |
| Complete Control Plane outage | 63.977 seconds without Control Plane preserves busy/idle Worker boots, the active lease and VM. Existing work and the retried new request complete after reconnect. |
| Image cold recovery | Immutable images of 6,294,269 / 6,294,393 / 25,129,437 bytes use native references of 596 / 596 / 597 bytes. A different Worker correctly recalls all three after replacement. |
| Full Cube | Chat without VM activation, coding, preview, warm reuse, background-process survival, 1,024-file fixture recovery on a fresh VM and stale-VM admission rejection pass. |

The real hosted gate covers ordinary completion and next-Run replay. Hosted-only
interruption, native Stop and ordered checkpoint reopening use deterministic
native-Harness/PG fixtures; this report does not claim a live hosted-search crash
experiment or actual Flash hosted-search availability.

### First child-recovery sample

The initial Run completed but failed the one-child assertion. Before its normal
fixture cleanup, the driver did not retain enough native details to classify it.
A read-only, read-committed scan then recovered its 168 records from the existing
Session Kafka partition without touching Projector offsets. The native history
contains two distinct model-issued `subagent run` calls: Entry 12 / commit 8 before
the crash and Entry 53 / commit 82 afterwards, with different Tool call IDs.
Between them the parent attempted status/wait with an invalid target, then issued
another delegation despite the fixture instruction. A second child consequently
executed another append. This was a new model decision, not redelivery of the
original Tool command or automatic unsafe-Tool replay.

The repeat adds evidence capture only; prompts, deadlines and assertions are
unchanged, and all assertions pass. Both samples and physical cleanup proofs are
retained. The failed sample is not counted as passing and the system does not
claim exactly-once effects across distinct model-generated commands. These samples
do not guarantee that a model will always reuse an existing child after an
interrupted launch. No argument-based deduplication of different native tasks
is introduced.

## Cleanup and limits

Normal lifecycle settlement and physical purge precede fixture ownership removal.
Final scoped cleanup removes three image objects and the three remaining fixture
projects/Workspaces. All test Sessions, Runs and owned accounts are removed;
PG business counts and native VM/Volume/reference/hold/open-allocation counts
return to the zero baseline. All seven original account/configuration/credential
fingerprints match, excluding API credential last-use timestamps. There are no
active writers, Tool bindings or unpublished controls. All service Pods are ready;
WSL and Windows localhost:8080 both return HTTP 200.

The 16-minute sample verifies the former ten-/fifteen-minute boundaries, not a
multi-day uptime or fleet-capacity SLA. Controlled one-hour and 24-hour clock tests
remain separate evidence. Lease, per-request/network/Tool and shutdown bounds
continue to protect their own operations; there is no replacement whole-Run timer.

Content-free aggregate evidence: [JSON](model-runtime-repair-20261020.json).
Private execution records remain under
`deploy/production/runtime/release-evidence/model-runtime-20261020/`.
