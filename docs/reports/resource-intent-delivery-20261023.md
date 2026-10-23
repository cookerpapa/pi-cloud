# Resource intent and dedicated-machine recovery delivery

Deployed as `resource-intent-cad5487a`, database schema 198. The main change is
`94ef10b2866a6d167452ece8f938ab68ca9fcecc`; the live-discovered compute-reference
repair is `cad5487a71171efdbdeeef680a76063d4818f2ab`. Native Cube management
protocol 8, guest protocol 7 and the Session/reply transports are unchanged.
[ADR-0273](../adr/0273-resource-intent-and-machine-recovery.md) records ownership,
recovery and build-versus-adopt decisions.

## Delivered behavior

PostgreSQL keeps user intent, ownership, admission reservations and lifecycle
completion. Cube supplies physical VM observations. A settled PG operation does
not claim that its VM is still running. Resource presentation combines the
current owner's disposable observations with durable intent/progress; IP samples
are no longer stored in PG.

A dedicated machine has one stable product identity and a separate current
allocation UUID. Desired running/paused/released state and intent revisions
survive Control Plane loss. Reconciliation adopts existing compute, respects
user pause and replaces positively stopped/unsafe/absent compute only after
closing old creation admission and confirming physical absence. An unreachable
node never authorizes replacement. Creation receipts resolve lost replies under
the original UUID; closed identities cannot reopen. The machine row retains the
current allocation rather than adding an allocation-history queue or scheduler.

Creation and recovery call Cube directly through SandboxProvider. Only Session
binding changes use the existing PG Outbox/Kafka path. Native Pi and ordinary Tool
publication/reply contracts are unchanged. Fresh compute enters the existing
native environment-continuity path; interrupted unsafe Tools are not replayed.
Image replacement uses the same environment-version publication helper as Run
admission, preserving the earlier immutable version.

Elastic allocation records use `allocated` independently of current users.
Ordinary borrowing/return no longer alternates active/warm resource states.
Binding and terminal reservations still protect pending admission and lifecycle
races; they are not a mirror of Cube health. Terminal completion is matched to
its physical allocation so a late old callback cannot clear a new terminal's
reservation. Cube retains sole ownership of finite idle expiry.

## Verification

- All 22 workspace suites passed across the main verification and corrected
  fixture repeats. The main Control Plane run passed 466 cases with four skips;
  Sandbox Control passed 326 with two skips. Focused recovery/migration and
  incarnation checks covered subsequent changes. The follow-up shared-compute
  and Volume suite passed all 12 cases.
- The final clean-revision fault run passed **370/370** cases at `cad5487a`.
  Isolated RF3/PG transport passed 9/9, including old-publisher fencing and
  replay without repeated external dispatch. Native Cube admission/allocation
  contracts, build/type checks, installation, Helm, runtime policy, documentation,
  observability, image closure and the maintained dependency policy passed.
- Both matched candidates included all 12 required images. The deployed
  candidate passed artifact provenance/SBOM checks with zero fixable HIGH or
  CRITICAL findings under the maintained policy. This is not a claim of zero
  findings of every severity.
- Real GPT-6 Luna and browser acceptance on the main schema-198 release passed
  Stop, returned-input handling, image resend/direct vision and bounded native
  Read output. Its owned tenant and physical resources were cleaned. These
  unchanged paths precede the final one-predicate compute-reference correction.
- Real GPT-6 Luna/Cube acceptance on the final runtime passed consecutive Turns,
  shared and ephemeral children, same-port parent/child preview isolation,
  terminal reconnect, SSH, pause/resume, Control Plane replacement and explicit
  machine release. The completed ephemeral child's preview remained usable
  after an additional 35-second wait spanning the ordinary cleanup cadence.
- An owned VM was physically removed while its product intent remained running.
  Recovery used a different allocation and the same machine/Workspace, preserved
  home-volume files and their test script, and produced native
  `pi-cloud.sandbox_reset` on the next real Tool-using Run. The old system-disk
  marker was absent, as required for a cold replacement.
- Deliberate pause survived Control Plane replacement without resuming the VM.
  Replaying an older pause receipt did not undo a later resume. The final driver
  uses the maintained stop-old / PG-owner-closure / start-new procedure and the
  existing independent restoration watchdog; both restoration receipts closed.

## Findings retained from unsuccessful samples

The first protocol and Web test runs contained old resource fixtures without the
new required desiredState field. Their complete repeat suites passed after the
fixtures were updated. An initial isolated Kafka topic-creation error passed an
unchanged transport repeat; no runtime timeout or fencing assertion was relaxed.

Live acceptance exposed an actual reference-classification error: ephemeral
children inherit a dedicated parent's product execution mode. The old cleanup
query counted only elastic-mode Sessions and retired those child VMs after
approximately 75 and 97 seconds despite visible child references. The corrected
predicate also recognizes non-null compute scopes. Deterministic PG coverage
checks both parent modes and eventual cleanup after reference removal.

Earlier host-driver samples used a legacy rolling restart, exposing the known
single-controller ownership gap and transient HTTP 502/503/terminal-admission
failures. The final driver follows the already-maintained replacement procedure,
waits for actual machine state and retries transport failures with the same
idempotency key. Overlapping-owner rolling upgrades are not claimed fixed here.
The failed samples remain in private delivery evidence.

## Preservation and cleanup

The original failed development machine recovered with the same logical machine,
Workspace and conversation. Its project directory was also read inside the new
VM using an owned creation receipt. All 25 original file hashes, 27 secret-file
hashes and protected rows across 15 account/configuration/native-history tables
match the pre-change snapshot, with no extra fixture history in those tables.

The follow-up matched cutover stopped the controller before retiring its idle
compute, retained desired running state, confirmed absence on the recorded node,
and preserved the Volume. The new controller then recreated compute normally.
No public Release action was used for the original machine.

All five dedicated acceptance fixtures have closed/absence-confirmed allocations,
purged Workspaces and no remaining conversations. One failed driver's leftover
conversation tree was removed through the product API after confirming physical
cleanup. Final state has no unfinished Runs, writers, Tool bindings, elastic VMs
or terminals; all-node native inventory shows only the retained original machine.
Configured secret values have no literal matches in the release/acceptance logs.

Private receipts and logs are under
`deploy/production/runtime/review-evidence/resource-intent-20261023/`.
The final follow-up commit updates host acceptance and documentation only;
serving runtime provenance remains `cad5487a`.

## Limits

Cold replacement preserves the persistent Volume, not previous processes,
process memory or arbitrary system-disk modifications. Ordinary pause/resume and
Control Plane replacement retain the existing VM/snapshot contract. Unknown
physical state keeps the old allocation pending; it cannot safely be treated as
a dead machine. These are single-node recovery samples, not multi-node HA or
fleet-capacity evidence. Open browser pages should reload for the matched public
resource schema.
