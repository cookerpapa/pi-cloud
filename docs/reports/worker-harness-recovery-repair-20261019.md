# Worker / Harness recovery repair

Status: implementation and required source checks complete; artifact preparation
and matched deployment are next. The serving release is still
`seal-projection-0de1fe7f`. This report does not claim deployment or live acceptance.

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

## Verification recorded so far

Workspace execution plus corrected targeted reruns covers **1,955 passing test
cases across 22 workspaces**, with 11 existing skips. The first full run exposed
an obsolete schema-190 expectation; its corrected schema-191 test passes. Two
additional cold-owner cases are included in the total. Initial test-fixture type
errors were corrected and both affected typechecks pass. Original failure logs
remain in private evidence.

The **79 acceptance-helper tests** and **nine real RF3 transport tests** pass.
The fault catalog includes 18 new cases; **341 cases in 99 groups pass**.
Source build, Cube native checks, Helm, installation, runtime policy,
documentation, formatting, image-closure and dependency audit checks pass;
artifact scans and live acceptance remain separate gates. The final read-pool
rerun also covers a primitive cancellation reason and preserves it unchanged.

Development measurements reach the model-permit boundary for 1/8/32/128 active
children in approximately 0.16/0.40/1.36/6.29 seconds, compared with the earlier
0.16/0.53/1.76/8.34-second baseline. The repaired fixture retains its faux model
descriptor across reattachment; final clean-source evidence will be recorded
after the source commit. These are short fresh text contexts, a cold native host,
possibly warm PG caches, pre-granted ownership and synchronous PG projection in
place of Kafka. They are not complete failover, provider or fleet-capacity timings.

Stopping after the first of eight child bindings admits zero model/VM effects
and withdraws all eight queued native inputs. The owned PG/Runner sample settles
in about 0.71 seconds. Native tests also preserve input IDs and instructions
without a reattachment commit, cover initial-admission reply loss, and retain
unsafe Tool non-replay and native Stop semantics.

## Deployment and acceptance

Pending the maintained drained matched release. Before-inventory confirms no
active Runs/writers/VMs, healthy Pods and available KVM. Original account/model/
credential fingerprints are retained for the after comparison.

Required live gates remain native input/Stop/Worker recovery, browser/Read/image,
native child handoff, Control Plane outage and full Cube acceptance. The prior
large-image cold-recall gate remains unaccepted until its own live check passes;
local cancellation or tiny-image evidence does not establish that result.

Private execution records are under
`deploy/production/runtime/release-evidence/native-recovery-20261019/` and owned
family samples under `runtime/review-evidence/worker-harness-recovery-20261019/`.
Only content-free aggregate evidence belongs in this report.
