# ADR-0204: bound Subagent task input before admission

Status: accepted for implementation, 2026-10-01 (R30-03 repair).

The public conversation prompt contract permits 100,000 characters. Subagent
admission and the Worker wire previously allowed 1,000,000, although the native
startup operation includes the prompt three times: originalPrompt, initialMessages
and its user Entry. A 400,000-byte ASCII task therefore cannot fit the unchanged
900 KiB execution-fact limit even before its envelope is added.

Use one character-limit constant for public prompt views and Worker input.
Subagent task text additionally has a 256 KiB JSON-encoded UTF-8 budget, including
quoting/escaping. Check it in native Tool argument preparation, workflow task
validation and the PG job-admission boundary before creating a child Session/Run.
Reject NUL and unpaired surrogates that PostgreSQL text/JSONB cannot represent.
Three maximum text copies leave more than 128 KiB for native/routing metadata.
Do not truncate tasks, remove native recovery fields, enlarge Kafka records or
introduce a general text attachment store. Existing user-upload/image ownership
is unchanged; this additional byte budget applies to delegated task descriptions.

The Tool schema advertises the character bound and its description explains the
byte budget. Oversized work is an explicit input rejection, so the Agent can use
shared context or Workspace paths. Public history retains the admitted prompt.
The Worker prompt character bound is aligned with the existing public schema;
there is no legacy one-million-character branch.

Acceptance compares ASCII, multibyte text, surrogate pairs and heavily escaped
input at their actual encoded boundaries. Oversized tasks must fail both Tool
preparation and direct PG admission; maximum admitted tasks must fit the real
native startup mutation with a 64 KiB envelope reserve and be
accepted by the public prompt schema.
