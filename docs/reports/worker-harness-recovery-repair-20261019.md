# Worker / Harness recovery repair

Status: deployed as `native-recovery-8c00826a`, schema 191, on 2026-10-19.
Source revision: `8c00826a09a1d1141c52a1bd38ef4561bf23aef8` (clean artifact source).
Required source/artifact and live gates pass, including native/child recovery,
browser/Read, Control Plane outage, large-image cold recall and full Cube acceptance.
Physical cleanup and original configuration preservation are confirmed.

Decision: [ADR-0262](../adr/0262-native-recovery-read-lifetimes.md).
Baseline and findings: [review](worker-harness-recovery-review-20261019.md).

## Changes

- **WHR-01/02:** Worker native data reads use a separate four-connection direct-PG
  pool, with 30-second acquisition/query bounds. Public Pi Context and owner
  cancellation reach queued/active SQL and image hydration. Read cancellation
  never interrupts acknowledged-commit adoption or substitutes for native Stop
  settlement. Image inventory mutations keep the ordinary authority connection.
- Socket eviction alone did not terminate a running PG query promptly. The read
  adapter now enables PG's one-second client-connection checks on the supported
  Linux deployment; the statement budget remains the fallback when network loss
  delays detection. Tests inspect the actual backend, not only a rejected Promise.
- Lease observation starts before the cold native head read. Revocation during
  that read disposes partial startup and retains a recoverable ownership result.
  An incomplete/corrupt checkpoint retains its original failure even though
  cleanup subsequently closes the authority.
- Known transient native-read failures stop the writer and enter existing ordered
  closure/same-Run recovery. A five-second delay uses PG time and the existing
  `runs.available_at`; existing polling wakes delayed work. No new queue, attempt,
  writer or automatic unsafe Tool replay is introduced.
- **WHR-O3:** schema 191 adds `pi_durable_submission_status`. Code-owned record
  kind predicates remain literal so actual named generic plans can use the partial
  index. Completed receipts are preserved. With 10,000 completed receipts and two
  queued receipts, tested queued/placed scans examine at most two record rows.
- **WHR-O1:** existing child restoration validates native configuration and the
  original Submission, then reattaches current cloud ports. It neither loads the
  original Tool prompt nor writes the same native configuration again. Remaining
  view/cursor reads use batches of 128; 257 controlled active views require three
  metadata queries. The family barrier still precedes external effects. Initial
  admission remains a separate prompt path; an explicit child `resume` cannot
  manufacture a missing Submission.
- **WHR-O2:** public Pi hooks run after context construction and do not encompass
  the repeated image reads. Per-decode validation/reuse is retained. This slice
  fixes image-read cancellation without adding a guessed cache lifetime, global
  byte cache or private Pi patch.

The old defect-asserting scripts are retained in Git at `19a0a2da` and removed
from the repaired checkout. Their replacements are maintained regression tests
and the real native/Runner family preparation/Stop experiment.

## Source verification

Workspace execution plus corrected targeted reruns covers **1,955 passing test
cases across 22 workspaces**, with 11 existing skips. The first full run exposed
an obsolete schema-190 expectation; its corrected schema-191 test passes. Two
additional cold-owner cases are included in the total. Initial test-fixture type
errors were corrected and both affected typechecks pass. Original failure logs
remain in private evidence.

The **79 acceptance-helper tests** and **nine real RF3 transport tests** pass.
The fault catalog includes 18 new cases; **341 cases in 99 groups pass**.
Source build, Cube native checks, Helm, installation, runtime policy,
documentation, formatting, image-closure and dependency audit checks pass. The final
read-pool rerun also covers a primitive cancellation reason and preserves it unchanged.

The first artifact preparation exposed an invalid runtime import in the slim
Cubelet image: attachment reads imported the database root although that image
intentionally includes only `database/client`. The follow-up source commit narrows
the runtime import to that existing module and retains the root import as type-only.
Both affected typechecks and 22 real-PG attachment tests pass. The replacement
candidate passes all **11 artifact scans**, with zero fixable HIGH/CRITICAL
findings under the maintained policy; the failed candidate was never deployed.

## Bounded recovery measurements

The final clean-source sample at `416e3cdf` reaches the model-permit boundary:

| Active children | Preparation time | SQL statements | Synchronously projected native commits |
| --- | --- | --- | --- |
| 1 | 0.154 s | 62 | 5 |
| 8 | 0.393 s | 237 | 12 |
| 32 | 1.298 s | 916 | 36 |
| 128 | 5.934 s | 3,735 | 132 |

SQL excludes lease observation and the substituted projection's write queries.
The earlier baseline was 0.157/0.534/1.758/8.341 seconds. The repaired fixture
retains its faux model descriptor across reattachment; the earlier fixture
reconfigured it. An independent same-configuration native bind still makes one
commit/write, while reattachment makes none. This comparison does not establish
a controlled production speedup ratio.

These are short fresh text contexts, a cold native host, possibly warm PG caches,
pre-granted ownership and synchronous PG projection in place of Kafka. They exclude
failure detection, old-writer closure, Pod startup, real model response and VM
creation; they are not complete failover or fleet-capacity timings. The experiment
is maintained under `scripts/experiments/review-worker-harness-recovery-20261019/`.

Stopping after the first of eight child bindings admits zero model/VM effects
and withdraws all eight queued native inputs. The owned PG/Runner sample settles
in 0.734 seconds. Native tests also preserve input IDs and instructions
without a reattachment commit, cover initial-admission reply loss, and retain
unsafe Tool non-replay and native Stop semantics.

## Deployment and acceptance

The maintained matched release drained writers and applied schema 191; Helm
revision 61 completed with 28 Pods ready. Execution-topic v17, boot reply v3,
guest/Tool protocol 7, completion startup 3, preview schema 2 and Cube management
7 remain unchanged. The unchanged guest source retains its existing template.
Live gates use `gpt-6-luna`:

- A real Worker crash during a native child's shell operation resumes the same
  root Run, child Conversation and Submission. The persisted configuration hash
  and revision count remain unchanged; the physical append occurs once. This is
  distinct from Control Plane replacement. The first attempt failed before fault
  injection because the fixture read a not-yet-ready Workspace; that sample was
  cleaned, and the corrected readiness polling retains all recovery assertions.
- All five native-input cases pass: consumption, Stop, Worker recovery, streaming
  Stop and simultaneous Worker/Control Plane crash. Interrupted text survives;
  in-flight bodies remain absent from PG. Worker replacement preserves the same
  SSE connection and the browser accepts execution generation 1 → 2.
- Real-browser uploads, returned queued images, direct vision and Read boundaries
  pass. ASCII and UTF-8 results retain Pi's 50 KiB bound and continuation diagnostics.
- Child control replies survive compatible Control Plane replacement with one
  physical execution and the same Worker. Replacement takes 13.788 seconds in
  this sample; completion follows 39.347 seconds after readiness.
- A 63.896-second complete Control Plane outage preserves the busy and idle
  Worker boots, the active lease and VM. New request retry, management reconnect
  and both Run completions pass.
- Full Cube acceptance passes pure chat without VM activation, real coding,
  preview, warm reuse and background-process survival. A 1,024-file Workspace
  survives explicit source-VM removal and attaches to a new VM; the old VM
  rejects late Tool/cancel admission. Final conversation deletion and confirmed
  native allocation closure release the unused runtime.

Those fixtures confirm physical cleanup. The first large-image attempt stored
6/6/25 MB images but exhausted the third Run's unchanged 600-second deadline;
three consecutive upstream requests each waited about 120 seconds with no HTTP
status or response bytes. It never reached cold visual recall. That failure and
its physical cleanup proof are retained. Following the owner's proxy-node switch,
the unchanged image gate passes: 6,294,598 / 6,294,221 / 25,130,191-byte immutable
images use native reference records of 596 / 596 / 597 bytes. The original path
is overwritten twice; after deleting the old Worker Pod, a different Worker
correctly recalls all three images without Tools. Both the previous and current
image Workspaces have completed physical purge. This establishes that the current
gate can pass on the switched node; it does not diagnose the earlier network failure.

## Cleanup and limits

All owned acceptance Sessions, Workspaces, fixture accounts and image objects
are removed after normal lifecycle settlement and confirmed native absence.
The final scoped cleanup removes six image objects plus remaining fixture metadata;
it never releases ownership based only on a missing heartbeat. PG business data
and native VM/Volume/reference/hold/allocation counts return to the zero baseline.
All seven original account/configuration/credential fingerprints match (excluding
API credential last-use timestamps). There are no active writers, bindings or
unpublished controls; all 28 Pods are ready. WSL and Windows localhost:8080 both
return HTTP 200. The three failed-candidate local image tags are removed; serving
artifacts and the existing guest templates remain.

The bounded family timing and individual process-failure gates do not establish
fleet capacity or physical-node HA. Repeated image hydration remains an accepted
cost until Pi exposes a suitable public encompassing operation boundary. This
release adds no child lease, queue, checkpoint head or unsafe Tool retry.

Content-free aggregate evidence: [JSON](worker-harness-recovery-repair-20261019.json).

Private execution records are under
`deploy/production/runtime/release-evidence/native-recovery-20261019/` and owned
family samples under `runtime/review-evidence/worker-harness-recovery-20261019/`.
Only content-free aggregate evidence belongs in this report.
