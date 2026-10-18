# Native Tool settlement repair

Date: 2026-10-18. Plan: [ADR-0255](../adr/0255-native-tool-result-boundaries.md).
The owner approved WHS-01/02/03 and selected native Pi default limits. Source
implementation is in progress; this record does not yet claim a matched release
or completed live acceptance. The serving baseline is `worker-reply-b1f67dba`.

## Implemented source behavior

- Coordination result admission uses 50 KiB of actual UTF-8 text and 2,000 lines,
  including Pi's trailing-LF convention. Structured values are serialized once;
  outer transport escaping no longer consumes a separate 256 KiB text budget.
  Oversize results/errors return a bounded diagnostic before native truncation.
  Guest workflow and trusted receiver boundaries share the policy. Subagent
  input budgets remain separate.
- Supervisor results keep their selected text and useful metadata, dropping
  duplicate output/reply text from `details`. Metadata is separately bounded;
  hostcall values are validated before the small execution-reference wrapper.
- Empty committed observer notifications do not read Entry bodies or sequences.
  Entry progress still advances. Sequence reads use acknowledged local metadata
  or a scoped `seq` query, without history bodies or image downloads.
- Native guest and packed Kafka result shapes are distinct PiCloud schemas.
  Text/normalized image/reference structure is checked before known settlement;
  malformed mailbox results receive the existing protocol-error classification.
  Empty content, diagnostics and opaque details remain supported.
- Review probes are archived in `f1d7dbbe`; their evidence remains in the review
  JSON. Maintained native, PG and protocol regressions replace bug expectations.

## Verification progress

Targeted native Harness, real PG metadata, workflow, protocol, completion and
mailbox tests are being run. Initial failures were fixture expectations: Vitest
spread an array case into arguments, a SQL fixture lacked a result-row type, and
the old progress-reply test expected the former generic error instead of the new
typed protocol error. These are being corrected without relaxing valid-content,
native-boundary or no-replay assertions.

Required repository/transport/fault checks, artifact evidence, matched cutover,
live Luna/Cube/coordination/image checks and physical/configuration cleanup remain
before delivery is complete.
