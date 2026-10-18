# Native Tool settlement repair

Date: 2026-10-18. Plan: [ADR-0255](../adr/0255-native-tool-result-boundaries.md).
The owner approved WHS-01/02/03 and selected native Pi default limits. Source
implementation `f6986780` passes all required repository, transport and fault
checks. Matched artifacts and live acceptance are pending; the serving baseline
is still `worker-reply-b1f67dba`.

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
mailbox verification passes 89 tests. Initial failures were fixture expectations: Vitest
spread an array case into arguments, a SQL fixture lacked a result-row type, and
the old progress-reply test expected the former generic error instead of the new
typed protocol error. Corrections retain valid-content, native-boundary and
no-replay assertions. Maintained tests also confirm metadata reads stay behind
publication acknowledgement and reject a poisoned owner after ACK uncertainty.

Full `npm run ci` passes on clean source `f69867806506adc53925010f500817f8ababe8e0`:
1,855 workspace tests, 77 helper tests, nine real RF3/PG transport tests and all
279 indexed fault cases. Types, builds, dependency hardening, formatting/docs,
installer, runtime policy, native Cube admission/allocation/Volume contracts,
Helm, observability and image closure pass. The npm security audit has no remaining
vulnerabilities. Separate browser-presentation, Docker context and native template
cleanup checks also pass. These do not replace artifact scans or live acceptance.

KVM API 12 and actual empty-VM creation are verified. The private release directory
`deploy/production/runtime/release-evidence/tool-settlement-20261018/` records the
idle native/control inventory and seven original configuration fingerprints:
32 tenants/users/API credentials, five password credentials and 35 model profiles/
credential bindings. Matched cutover, real Luna/Cube/coordination/image checks and
positive fixture cleanup remain before delivery is complete.
