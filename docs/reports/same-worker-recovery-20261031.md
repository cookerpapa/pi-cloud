# Same-Worker execution recovery

Matched `same-worker-recovery-20261031` is deployed from
`79a01393046d0e8104fb264cb6cea6546bb2afe2`, on schema 206 and platform Helm
revision 135. The later `a1535b70` correction changes the acceptance driver and
its operator-source classification, not runtime images. Both the dedicated
same-process case and maintained native recovery acceptance passed.

## Behavior

The [reported failure](command-identity-and-message-controls-20261031.md) arose
because a Run-keyed duplicate cache treated a legitimate new Session lease as
changed command content. The existing ExecutionReference already identifies the
Run, lease and epoch; it now scopes local execution and cancellation outcomes.
Family fencing is checked before returning a cached duplicate. Payload changes
within the same incarnation remain conflicts.

A higher authorized owner can resume the same Run without restarting the Worker.
Old execution callbacks retain their own object/reference. Releasing an old
preparation or completing an old cancellation cannot erase a new opening or drain
its Writer. Superseded preparations release their unused slot; superseded running
executions remain retained until the Runner actually exits.

Once a higher authorized owner exists, settled older outcomes can be reaped
while the logical Run continues. Current family epoch protection remains.
Other outcomes still require the existing PG terminal-retirement check.
This corrects [ADR-0229's recovery mapping](../adr/0229-native-durable-runtime.md);
Pi core, PG/Kafka authority, wire formats and storage schema are unchanged.

The existing admission timing log now carries Worker, lease ID and epoch.
`run.recovery.requested` records a bounded reason after a local recovery request
commits. It adds no SQL query or history record, and a logging failure cannot
change the committed outcome. See [observability](../OBSERVABILITY.md).
Previously unrecorded triggers are not reconstructed from these new logs.

## Source verification

- 597 relevant cases passed across Supervisor (306), Worker host (96), Runtime
  core (111) and five real-PG admission/renewal/recovery suites (84). Two unrelated
  opt-in Runtime-core cases remained skipped. The operator change passed 18
  additional release-classification/manifest tests.
- The five initial same-Run regressions failed against the old implementation.
  The final Supervisor file passed all 28 cases, including new leases on one
  logical Run, old lease/cancellation rejection, same-incarnation duplicates,
  delayed completion, a pending retirement read, pre-start release and repeated
  recovery with bounded obsolete-state retention.
- The PG test keeps the same Supervisor and execution backend alive across
  admission, requested closure, ordered projection and re-admission. It checks
  the new lease, advanced position and completed logical Run. Another PG test
  holds an old cancellation reply until a later Session execution starts, then
  proves its Writer was not drained.
- Recovery log checks use the real redacting logger: numeric epochs survive,
  while the private exception message is not logged.
- Relevant four-package typechecks, formatting, documentation, syntax and matched
  Docker input/provenance checks passed; the maintained 12-image scan gate passed.

The initial full Supervisor invocation lacked its required test PG and failed
that file's setup. Its two cases passed with isolated PostgreSQL. A new retirement
fixture initially gated the old and new executions by Run ID; it was corrected
to gate by ExecutionReference and passed. A duplicate CLI worker-count option
was removed from the host test invocation. Initial failures and exact rechecks
are retained separately rather than counted as successful full invocations.

## Actual same-process recovery

The new maintained driver temporarily reduces an idle Worker pool to one using
the existing deployment, eliminating scheduling ambiguity without adding Session
affinity. In its fresh tenant, Luna completed a Bash that appended one marker,
then started a second held Bash. The driver requested recovery through the
existing PG control Outbox, Kafka closure and Projector path.

The same logical Run was admitted under epoch 2 after epoch 1 was sealed.
Worker ID, boot, Pod UID, container identity, start time and restart count remained
unchanged throughout this case. The Run completed successfully; the marker file
contained exactly one line. The original two-Worker pool size was restored and
the fixture's VM/Volume, conversation and tenant were purged.

The first driver attempt exceeded the tenant-slug length limit before creating a
tenant or Run. It restored the pool size. The corrected driver passed and records
both the actual runtime revision and its own source hash.

The separate native-input driver passed all five scenarios: consumption, Stop,
Worker crash, streaming Stop and simultaneous Worker/Control Plane crash.
Stable input identity, retained partial output and native continuation held;
transient streaming bodies were not retained in PG. Those owned resources were
also purged. These later crash tests are separate from the same-process proof.

## Publication and preservation

Original writers and bindings were quiescent before compute retirement. Old
allocation closure and physical absence were confirmed while Workspace Volumes,
machine intent, accounts and configuration remained. Both machines recovered
at generations 36 and 6. Original applications on ports 4189, 4190 and 8000 were
restarted from fresh inventories and served matching HTML.

Before application restart, strict verification matched 5,998 Workspace files,
14 protected database tables and 27 configuration/credential files. All 150
retained images matched. After acceptance, protected records, configurations and
images still matched; Workspace differences were limited to three application
logs and the application's normally refreshed snapshot.

Both recovered original allocations survived the fault checks. All 29 serving
Pods were Ready, with no active Run, writer, Tool binding or elastic fixture.
The original failed Galgame Run was not rewritten or replayed as an acceptance
fixture. Its historical failure remains recorded.

Private evidence is under
`deploy/production/runtime/work-evidence/same-worker-recovery-20261031/` and
`deploy/production/runtime/release-evidence/same-worker-recovery-20261031/`.
The deferred 131 MiB cold-image experiment was not reopened.
