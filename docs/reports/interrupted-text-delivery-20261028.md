# Interrupted assistant text delivery

Status: deployed as `interrupted-text-jose-20261028`, source `57ddff48`, schema 202,
Helm 119. Feature, full Cube, native recovery and large-image cold-recall
acceptance pass.

ADR-0283 preserves the last recorded visible assistant text of a cancelled native
GenerationTask, at its original position, with `[Reply interrupted]`. One native
context-only edit retains the original aborted receipt and does not create another
display message, Tool effect, Run, or usage receipt. The native derived context
also feeds compaction and token estimation. Original provider identities, opaque
signatures, thinking and Tool carriers are excluded from the replacement.

The Worker prepares active recovered Conversations before native scheduling,
prepares a Conversation when it binds, and retains cancelled text before cloud
terminal settlement. Manual compaction uses the same preparation. Reads use the
native active context only. A transaction checks its tail before appending and
respects pre-existing native edits; duplicate calls and cold replay produce one
replacement. Missing/failed tasks and ordinary provider-error responses are not
promoted to successful work. The original Run outcome remains unchanged.

The new native contract checks cover next-request ordering, immutable aborted
history, unchanged usage, compaction, a cold owner, inherited forks, idempotence,
existing omissions, revoked ownership, and failure before/after the context edit
commit. A separate actual Runner/stream check verifies Stop produces its cancelled
outcome, stores the context edit and does not show its marker as another browser
message. The focused Worker and PG conformance gate passes 376 checks before that
additional Runner check; the latter also passes independently.

Real provider preflight passes GPT-6 Luna and DeepSeek Flash with thinking enabled,
Tools advertised and preceding Tool history. Both recall a synthetic identifier
provided only in the normalized interrupted assistant text and follow the user's
correction. The first Flash probe rejected forced Tool choice in thinking mode;
the same probe using supported `auto` selection passes. This was a fixture
parameter error, not a context-format workaround.

An initial direct Worker test command did not provide the maintained PG fixture
endpoint, so its PG suite timed out. The repeat through `run-with-test-postgres`
passes all Worker/PG checks. Failed samples remain in private evidence rather than
being counted as acceptance.

The full workspace check exposed an existing WebSocket fixture that used the same
100 ms idle deadline for its Stop, owner-revocation and idle-expiry cases. The Stop
case returned an error twice under build/test load, while the earlier limited
concurrency pass succeeded. The corrected fixture retains 100 ms for the
idle-expiry case and uses its ordinary 2-second deadline for Stop/owner cases.
Production model deadlines and cancellation code are unchanged. Failed runs
are retained, and the complete Worker workspace was rerun before publication.

That complete Worker repeat passes all 303 tests in 39 files. All other workspace
checks passed in the original composed run (1,948 tests), and the separately run
acceptance-helper suite passes 119 tests. The deterministic fault suite passes
375/375; its provenance correctly retains the pre-commit dirty-worktree stamp,
rather than claiming the final clean image revision. The dependency update passes
17 focused release contracts. Twelve matched image scans pass without exceptions.

Deployed-stack acceptance is maintained in
`scripts/run-live-interrupted-text-check.mjs`. It creates owned Sessions, observes
real model text, issues Stop, checks raw PG source/edit records and asks the next
Run to recall a code generated only in the interrupted answer. It verifies browser
history still contains the original response and performs physical fixture cleanup.

The first invocation failed before feature validation because the driver omitted
the required SSE status callback; adding it and awaiting SSE attachment fixes the
fixture. Its owned resources were cleaned before retry.

The repeated live driver passes GPT-6 Luna -> Luna, Luna -> DeepSeek Flash,
Flash -> Luna, and Flash -> Flash. Every original response is stored as aborted,
has exactly one context-only edit, and the new Run recalls the assistant-generated
code that was never supplied in the user input. No context marker appears as a
second browser message. Fixture cleanup is confirmed.

The full Cube gate passes guest Read bounds/aliases, actual cancellable Bash,
browser lost-ACK handling and Stop-return/resend of the same image attachment.
Native-input acceptance passes all five scenarios, including pending input
recovery, stream Stop, and simultaneous Worker/Control Plane crashes. Their
owned tenants, Volumes and images are removed through the maintained cleanup.

The original machine was retired only after quiescence and confirmed physical
absence; its Workspace Volume was retained. The new allocation restores the
original Node application on port 4188 with the same HTML hash. The first
post-cutover check preserves all 15 protected database table snapshots, 5,856
Workspace files apart from the expected server log/PID changes, 27 configuration/
secret hashes and 60 referenced images. Final post-fixture verification repeats
those checks successfully; all 29 Pods are ready, with no active fixture Runs,
writers, bindings or elastic VMs. The retained machine is generation 23 and its
original preview content still matches.

Large-image acceptance passes unchanged: 6,294,433-byte, 6,294,605-byte and
25,129,211-byte PNGs, including source overwrite, immutable retained attachments
and correct vision recall after replacing the Worker. Native history holds only
596/597-byte attachment-reference records for those images. Cleanup is confirmed.

Private evidence: `deploy/production/runtime/release-evidence/interrupted-text-20261028/`.

The first matched image scan blocked publication on CVE-2026-116587 in Caddy and
Cubelet's two binaries, all using go-jose v4.1.4. The release pins upstream v4.1.6
in the Web builder and the checked Cube module/sum patch; original failed image
evidence is retained. An intermediate candidate was also rejected for stale OCI
source labels after the test-only fixture correction. A fresh candidate at
`57ddff48` passes source-label and vulnerability checks. The
[upstream release](https://github.com/go-jose/go-jose/releases/tag/v4.1.6)
also documents its 4096-bit default bound for imported RSA JWKs. This dependency
update does not alter Pi's execution or context implementation.
