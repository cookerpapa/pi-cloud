# October 4 review repairs

Started 2026-10-05 from `c3f5f6bd`. The owner approved the repair proposal.
The seven repairs and browser fixture correction are implemented. The matched
native/application release is deployed and combined verification is complete.

## Lifecycle slice — ADR-0224

- R04-01: separate short observation deadlines from accepted Cube cleanup.
  Use the configured native destroy budget independently of caller cancellation;
  reserve outer transport time through Master, API and the PiCloud client.
  Recheck terminal state after the allocation lock. Cleanup never reopens creation.
- R04-02: prepare recovered bindings and durable state before publishing local
  availability. Storage/binding failure after successful adoption remains retryable
  without quarantining the verified VM. Contain health-target enumeration errors.

Validation so far: native allocation package with race detection; native
paused-delete/managed-cleanup service tests with CGO disabled (local static
cubecow library unavailable); controller, runtime client, monitor and recovery
tests. Native production build and live acceptance remain required.

## PG decision slice — ADR-0224

- R04-04: owned lifecycle transactions lock the controller before resources,
  then check PG expiry again before commit. Retirement uses the same lock order.
  Waiting past expiry rolls back authorization; no Cube RPC runs under a PG lock.
- R04-07: ticket issue returns PG-computed expiry; consume checks it after the
  ticket lock. Removed the independent application-clock policy.

All 22 full-schema ownership tests pass, including both ordering and deadline
cases for creation/closure. All 14 SSH-consumption/development-machine tests pass;
the narrow consumption fixture verifies expiry during lock wait and one-time use.

## Pi request-policy slice — ADR-0224

R04-05: ordinary sampling and native Compaction apply one common request policy
for transport, timeout and frozen service tier. Summary session IDs, cache policy
and output limits remain Pi-owned; hosted search is sampling-only. All 91 runtime,
lifecycle and request-policy tests pass, including Standard/Fast compaction.

## Structured Tool failure slice — ADR-0225

R04-06: v2 boot replies distinguish native `tool_result` from
`execution_failure`. The mailbox validates callback identity and carries typed
failure code/effect status to the Harness. Fixed Tools and workflow dispatch use
the same classification; ordinary native error text is never parsed for control.
Native Bash prefix regressions, mailbox wire/identity checks, real Agent failure
settlement, completion images/probes and dispatch tests pass (82 assertions).
Matched rollout and broad verification remain required.

## Volume state slice — ADR-0226

R04-03 replaces managed allocation reply deltas with durable Volume holds and
versioned node reference state. Node metadata records unfinished detach before
the plugin hook and synchronously commits its incarnation/revision. Master
closes attachment admission before deletion, keeps node identity after allocation
receipt collection and refuses unknown/changed metadata. Cube native protocol is
7; guest Tool protocol remains 3. Migration `20261005000000` adds the Cube Volume
state tables and removes the obsolete managed delta-application flags.

Real Bolt/race tests cover a failed detach-state write, restart and the lost first
allocation cleanup receipt. Six real MySQL/race tests cover shared references,
duplicate/stale replies, metadata replacement, pending creation, receipt GC,
historical untracked holds and concurrent placement/deletion. Native Volume/API
targeted tests and paused-delete composition pass. A broader upstream snapshot
test crashes in uninitialized node-cache fixture setup; the same named test
also fails on unchanged `c3f5f6bd` native source. It is outside this repair's
passing claims. Production build and real-VM acceptance remain pending.

## Verification and dependency cleanup

Q04-01: the maintained browser fixture now supplies the current queue protocol
and passes it through the production parser. The original browser command passes
all recorded interactions. Test-only MySQL image pins moved out of the production
runtime identity, verified against the real completion image input closure.
Error-only imports use the existing leaf module and the final-seal comment now
distinguishes prior cancellation settlement. Obsolete review characterizations
were replaced by maintained regressions; their original source remains in the
named review commit. Historical report results retain their original baseline.

## Matched release and live evidence

Cube API/Master/Cubelet use `review-boundaries-v7`, native patch identity
`0d27a51febdc87d9`, completion source
`0d36631cd419e04c29e52dc73d9d89d96c9d7e1b`. Applications use
`review-boundaries-v7-app`, runtime source `935f89cf`; later changes are regression
fixtures, acceptance scripts and documentation. Guest source remains
`992bcf3ad59056d2eb43b87f623fd351661ae47f` / protocol 3. Cube migration is
`20261005000000`; PG schema remains 174. No business-data reset was performed.
The Cube metadata backup is retained in the private runtime backup directory.

The drain found no pending/active Runs and exact node inventory had no VM in any
state. The first application preflight observed Cubelet still starting after
Helm returned; deployment resumed once all node containers were ready. The final
release reconciled through the existing Helm renderer and restored the API plus
two Workers. The baseline had no native history rows, so its empty hash is not
evidence of restoring an existing user's long conversation.

- [Native allocation/Volume](allocation-volume-acceptance-20261005.json): two
  actual VMs share bytes. Paused direct Close succeeds; the sibling still reads
  its file; Volume deletion returns conflict while referenced; new placement and
  delayed old Create are refused; final Volume deletion/owned cleanup succeed.
- [Native Tools](native-tools-acceptance-20261005.json): three Luna Runs exercise
  write/read/edit/bash, bounded large output and symlink behavior.
- [Ordinary error classification](tool-error-classification-20261005.json): a
  real Bash exits 7 with `ownership_lost` text; its Tool fails, the next Bash and
  Run complete. It does not become infrastructure unavailability.
- [Images and Worker replacement](image-attachments-acceptance-20261005.json):
  6.3/6.3/25.1 MB normalized images travel as 778/778/779-byte native records;
  a new Worker recovers visual context after the Workspace image changes.
- [Fast compaction](fast-compaction-acceptance-20261005.json): actual Pi/Luna
  summarization and subsequent sampling pass the production Gateway's Fast
  policy with an isolated small context window, retaining the project marker.
- [Development machine](development-environment-acceptance-20261005.json):
  controller replacement, shared/separate-compute Subagents, preview/terminal,
  one-time SSH, pause/resume and Volume release pass; physical continuity and
  conversation lifetime retain their separate contracts.
- [Cancellation](tool-cancellation-acceptance-20261005.json): original foreground
  Tool cancellation settles in 574 ms, retains partial output/context, preserves
  completed background work and independent groups, and leaves a shared sibling
  running. A later explicit command manages those surviving processes.
- [Unavailable cancellation endpoint](tool-cancellation-fault-20261005.json):
  pausing the Cube API produces bounded UNKNOWN settlement in 22,350 ms, with
  one execution, retained interruption context and an unaffected sibling.
  The endpoint resumes and owned cleanup completes.

These are owned, single-host acceptance cases, not physical-node HA or a fleet
capacity claim. The two historical untracked UNKNOWN allocations stay held.

## Verification bookkeeping

The first `npm run ci` passed build, native contracts and workspace types, then
found one integration fixture still simulating infrastructure loss as native
error text. That fixture now raises the actual structured failure, retaining its
original expectation that cleanup cannot overwrite the Run's primary failure.
All 264 supervisor tests pass. The recovery fixture also honors excluded IDs,
and the SSH package provisions isolated PG when invoked on its own.
The corrected `npm run ci` exits 0: 1,697 workspace assertions plus 63 acceptance
helper assertions pass; nine opt-in external-service assertions are skipped.
All 178 fault cases pass. Native allocation/Volume race and persistence checks,
paused-delete composition, builds/types, formatting, documentation, Helm/runtime
policy and the high-severity dependency audit pass. The maintained browser gate
also passes. The audit retains two moderate dependency findings; it is not a
claim of zero advisories.

[Verification record](review-repair-verification-20261005.json) ·
[Fault evidence](review-repair-faults-20261005.json) ·
[Matched deployment and final inventory](review-repair-rollout-20261005.json).

All live fixtures above completed their owned cleanup. Final checks found zero
pending/active Runs, development machines, live Workspace runtimes and VMs in
the node's all-state inventory. Existing untracked UNKNOWN allocations remain
exactly two. The native Session log returned to its empty pre-acceptance baseline.
