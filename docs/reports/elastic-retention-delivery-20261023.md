# Cube-owned elastic retention delivery — 2026-10-23

## Delivered behavior

[ADR-0272](../adr/0272-cube-owned-elastic-retention.md) is delivered as
`elastic-retention-03ce2f23` from runtime source `03ce2f23fff5685c91d60c08bb9d5f314bf25207`.
Schema 197, Session topic v18 and guest Tool protocol 7 remain; managed Cube
protocol is 8. The existing Cube API authorization callback now belongs to the
matched build/scan/replacement set, which contains 12 images.

An active physical Session publishes a small retention intent every 15 seconds
through its existing transactional Kafka producer. The Session Projector resolves
an existing compute reference at bootstrap or binding change, then combines
ordinary renewals to at most one per physical VM every 30 seconds. Pure chat
creates no VM to send a heartbeat. There is no per-pulse PG row or native chat
entry, no new topic/group, and no change to Pi's agent loop.

Cubelet stores the original activity time plus the immutable retention window in
its existing synchronous allocation journal. The default window is 15 minutes.
Its existing maintenance loop atomically closes an expired allocation against
Tool admission before physical cleanup. Accepted unfinished Tools and actual
terminal/preview connections retain compute; diagnostic probes do not. Duplicate,
stale and delayed renewals cannot reopen a closed allocation or extend a different
VM generation. The generic Cube timeout stays disabled to avoid a second idle
reaper; dedicated machines have no idle-retention deadline.

The old controller idle deadlines and warm-count/LRU eviction are removed.
Control Plane still owns admission, explicit lifecycle decisions, recovery and
quota accounting; it releases quota only after recorded-node absence is confirmed.
Workspace Volume bytes and native conversation history survive compute expiry.

## Verification

- Maintained source build/type, formatting/docs, installation, Helm, runtime-policy,
  observability and image-closure checks passed. Workspace checks ran in isolated
  groups; the original serial scheduler was stopped after the control-plane suite
  completed to avoid repeating groups already tested independently.
- Control Plane: 459 tests passed, four explicitly skipped. The other 21 workspace
  suites, acceptance-helper tests and transport integration passed. The fault
  manifest passed all 361 cases; the source dependency audit passed its maintained
  policy. Skipped paid/live fixtures are not counted as executed source tests.
- Maintained pinned Go race/MySQL/Volume/execution contracts and Cubelet service
  checks passed. Focused renewal callback/client/release contracts passed 87 tests.
  Coverage includes original timestamps, duplicates, closed/old identities,
  persistence failure before Tool start, active-Tool expiry admission, restart,
  dedicated exclusion, shared-target delivery and bounded blocked requests.
- Fake-clock Worker verification covers more than 30 minutes of model silence
  without another native commit. Seventy child resource references are split
  without truncation or separate writers. This is source evidence, not a claim
  that a paid provider request was kept silent for 30 minutes.
- All 12 published artifacts have matched source/image evidence and pass the
  zero-fixable-HIGH/CRITICAL policy. No scan gate or timeout assertion was weakened.

The real GPT-6 Luna acceptance passed browser Stop/returned input/image resend,
direct vision, complete native Read truncation, and the following retention path:

1. Write a unique marker into an owned Workspace file.
2. Run a no-Tool chat turn and observe renewal of the same physical VM.
3. Stop the sole Control Plane at `04:29:31 UTC`. Repeated independent samples
   show zero controller Pods, a live VM, and an unchanged deadline.
4. Cube closes and removes the VM after that deadline. The actual idle wait was
   **906,115 ms**; confirmed absence was observed **12,928 ms after** the accepted
   deadline. Diagnostic polling did not extend it.
5. Restore Control Plane and run a native Read on a different VM using the same
   Workspace. The successful Tool result contains the retained marker; native
   history records `pi-cloud.sandbox_reset`. The model's final answer matches.
6. Delete only the owned acceptance resources and confirm physical cleanup.

The retained live Read proof was captured from PG before fixture deletion and
contains result hashes and booleans, not transcript text. The host acceptance
helper additionally asserts no early expiry and an actual successful native Read,
and saves its outage/restoration state immediately. The executed sample satisfies
those assertions independently of the model's final text.

The additional real Luna native-input acceptance passed all five scenarios:
consume, Stop, Worker crash/recovery, streaming Stop, and simultaneous Worker /
Control Plane process crashes. Native partial text and pending-input identities
survived recovery, and both owned acceptance tenants were physically cleaned.

Final verification confirms zero native VMs across 1/1 nodes; zero unfinished
Runs, writers, Tool bindings, elastic allocations or terminals; and healthy
platform Pods. All protected rows in 15 PG tables, 25 Workspace file hashes and
27 secret-file hashes match the pre-change baseline, with no extra test rows.
The PG comparison excludes routine touch/usage timestamps; configuration and
credential values are compared without that exclusion.

## Preservation and retained failures

The pre-existing dedicated machine had already exited after host shutdown. The
maintenance operation drained the controller, closed PG allocation admission and
confirmed absence on its recorded Cube node. It retained the failed machine's
ownership record and Workspace instead of invoking public Release, which would
delete the Workspace. The first state update incorrectly cleared ownership fields
and was rejected by the existing PG shape constraint. The controller remained
offline until the update was corrected; no constraint was bypassed. Before and
after matched cutover, all 25 Workspace file hashes, 27 secret-file hashes and
protected rows in 15 PG tables matched.

The first candidate exposed a missing callback route during inspection, before
cutover; the corrected callback is now tested and published with Cube. Two
unpublished candidates were abandoned, and their four unused native image tags
and incomplete candidate directories were removed. Their diagnostic logs remain.

The original Ubuntu mirror delivered the build's package index slowly. The build
now accepts an operator-selected HTTPS Ubuntu archive and forwards `NO_PROXY`;
this release used the USTC mirror with ordinary Ubuntu signature/version checks.
The proxy address, guest/provider egress and vulnerability policy did not change.

An initial ad-hoc PG invocation used the generic short Vitest timeout and failed;
the maintained package command passed the same 32 tests without changing limits.
An extra generic Cube timeout fixture could not initialize its local test cache;
that unused generic renewal API is not the implemented path. Maintained native
checks and actual builds passed. A scope-less `release:check` invocation was
rejected because that command is for scoped provider/catalog/web releases; this
protocol change used the full matched checks instead. A transient kubectl
“container not found” occurred during the intentional simultaneous process-crash
fixture; recovery and cleanup subsequently passed.

## Limits and remaining work

This demonstrates the maintained single-node installation, not multi-node HA or
fleet capacity. A prolonged renewal-path outage can expire idle elastic compute
while an Agent still exists; that is the approved finite-retention policy. A live
accepted Tool still owns its lifetime. Cube/node/storage outages can delay
physical cleanup and quota release; missing probes never prove absence.

Dedicated-machine automatic recreation after host shutdown and its misleading
Resume wording remain a separate [backlog item](../BACKLOG.md). The original
conversation and Workspace bytes are retained; this release does not make that
failed dedicated machine resumable. No overall Agent runtime limit was introduced.

Private artifacts and logs are under
`deploy/production/runtime/review-evidence/elastic-retention-20261023/` and the
matched candidate under `deploy/production/runtime/releases/elastic-retention-03ce2f23/`.
