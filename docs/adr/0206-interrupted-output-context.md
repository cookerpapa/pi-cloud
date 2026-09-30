# ADR-0206: interrupted visible output remains model context

Status: accepted for implementation, 2026-10-01 (owner decision D30-03).

Pi's provider conversion excludes errored/aborted Assistant messages. Preserve
the exact native message in storage, but project its ordinary text as explicitly
incomplete contextual data before the next model request. Do not replay thinking
blocks, partial Tool arguments or pretend the failed response completed normally.
Use the existing interrupted-assistant custom message representation. Deriving
it from the native entry avoids a crash gap between writing the failed message
and writing another copy of its visible text.

Apply the same projection to retained-tail messages and Compaction preparation.
Compaction can summarize or retain the text using its native rules; it must not
silently filter the text before summarization. Already projected custom messages
remain single facts, without repeated wrapping on subsequent Runs.

Interruption facts use code-owned reason categories and fixed safe explanations.
The trusted outer runtime supplies known Tool/cancellation/timeout causes;
unknown causes remain unknown. Raw provider diagnostics, stack traces and
credentials stay out of model context. A missing Tool result is not proof of a
VM crash or of zero side effects.

Cold recovery keeps the existing pending visible-prefix materialization. It
also materializes a missing interruption fact for the immediately preceding
failed/cancelled Run, using the sealed PG outcome. Deterministic recovery IDs
and the native log prevent duplicate facts. No separate receipt table or state
authority is introduced, and old owners never gain permission to append after
lease loss. Successfully completed predecessors do not reintroduce old failures.

Acceptance covers normal model failure, cancellation, known Tool loss, crash
after the native failed message is stored, hard loss with/without visible text,
repeated cold restore, Compaction and absence of private diagnostics or partial
Tool replay. Infrastructure failure still ends the current Run; this decision
improves the next Run's context rather than restarting failed work automatically.
