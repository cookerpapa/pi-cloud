# Interrupted assistant text delivery

Status: implemented; matched release and live acceptance pending.

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

The full workspace pass exposed an existing WebSocket fixture that used the same
100 ms idle deadline for its Stop, owner-revocation and idle-expiry cases. The Stop
case returned an error twice under build/test load, while the earlier limited
concurrency pass succeeded. Separate the fixture budgets: retain 100 ms for the
idle-expiry case and use its ordinary 2-second deadline for Stop/owner cases.
Production model deadlines and cancellation code are unchanged. Preserve the
failed runs and rerun the complete Worker workspace before publication.

Deployed-stack acceptance is maintained in
`scripts/run-live-interrupted-text-check.mjs`. It creates owned Sessions, observes
real model text, issues Stop, checks raw PG source/edit records and asks the next
Run to recall a code generated only in the interrupted answer. It verifies browser
history still contains the original response and performs physical fixture cleanup.

Private evidence: `deploy/production/runtime/release-evidence/interrupted-text-20261028/`.

The first matched image scan blocks publication on CVE-2026-116587 in Caddy and
Cubelet's two binaries, all using go-jose v4.1.4. Pin the upstream fixed v4.1.6
in the Web builder and the checked Cube module/sum patch; retain the original
failed image evidence and use the normal scan gate. The
[upstream release](https://github.com/go-jose/go-jose/releases/tag/v4.1.6)
also documents its 4096-bit default bound for imported RSA JWKs. This dependency
update does not alter Pi's execution or context implementation.
