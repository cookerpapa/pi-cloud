# Input-admission read reuse

Source baseline: `a5d64c18`; implementation and deployed source: `db0548b8`.
Decision: [ADR-0240](../adr/0240-transaction-scoped-input-admission.md).
`input-admission-db0548b8` is deployed on October 10, 2026. This is one
intake-query slice on schema 183, without a cross-request cache, new storage
authority or public protocol change.

ControlPlaneStore now supplies a callback-scoped transaction with the locked
Session, a fresh initial-request lookup and a bound action for accepting that
request. QueuedInputService uses the same facts when it chooses initial intake
or native continuation. The action rejects calls after the callback ends.
Worker delivery and its fresh grant check remain outside this transaction.

## Query counts

The real PG tests count completed application SQL statements, not CTE-builder
callbacks or SQL executed internally by triggers. Normal intake means an
existing conversation, an elastic Workspace and a new text-only initial request.

| Path | Before | After |
| --- | ---: | ---: |
| Public initial-intake business statements | 9 | 8 |
| Same-key initial-input retry | 3 | 2 |
| Direct internal Store initial submission | 5 | 5 |
| Worker claim/admission | 9 | 9 |

Authentication normally adds one SQL statement; driver BEGIN/COMMIT add two.
The ordinary browser request therefore goes from 12 to 11, with one more
statement when authentication usage metadata needs refreshing. These counts do
not include creating the Session, attachments, development-machine checks,
environment replacement or later Worker/Kafka/native projection work.
This removes one round trip; no latency or throughput improvement is asserted.

## Failure checks

The 73-test targeted intake/admission/recovery group passes. New real PG cases
cover two replicas contending on the Session lock with matching or changed
payloads; model changes before and after intake; atomic rollback/retry; action
lifetime after commit/rollback; Workspace deletion after the Session read; and
mismatched tenant scope. Existing native input, Stop and recovery tests pass.
Both the direct Store and Worker claim query budgets remain unchanged.

The separate idempotency query deliberately remains after the Session lock.
It sees a Run committed during a lock wait, avoiding a stale joined snapshot.
Model/environment/Workspace validation is retained, and no snapshot is reused
by a later request or by post-transaction Worker delivery.

## Verification and rollout

- All 22 workspace typechecks pass.
- Full workspace tests: 253 passing files, 1,660 passing tests; seven files /
  nine existing environment-gated tests skipped, no failures.
- All 227 registered deterministic fault cases pass, including seven new
  input-admission cases.
- Acceptance helpers: 15 files, 64 tests pass.
- Formatting and documentation checks pass.
- The authorized matched rollout and owned real-model acceptance pass.

Source checks use disposable PG fixtures and spend no model tokens. The source
code remained unchanged while the full gates and candidate build completed;
the private source summary records the tested patch and implementation revision.

## Matched deployment and live checks

The [matched procedure](../MATCHED_RELEASE.md) built/scanned eleven images and
verified their source/artifact identities, reusing the exact registered guest
where inputs were unchanged. The existing zero-fixable-HIGH/CRITICAL gate passes;
unfixed findings remain recorded, without scan-policy changes. Pi Durable 1.0.0,
guest/Tool Worker protocol 4 and Cube management protocol 7 remain matched.

Before cutover there were no active Runs, unsealed writes or VMs. Writers were
drained before the matching Cube/application release was installed. No business
reset or schema conversion was required. Web, Control Plane and both Workers
serve `input-admission-db0548b8`.

- Two concurrent identical HTTP initial submissions return one Run, with one
  new acceptance and one replay. Another same-key retry returns that identity;
  changed content under the key is rejected. Luna completes one model request.
- Native follow-up, editing, promotion, retry identity and Stop restoration
  remain in one Run. The owned native-input fixtures are purged.
- Real browser lost-response/Stop/image-return/resend, direct vision and large
  ASCII/Unicode Read diagnostics pass. Owned browser fixtures are purged.
- The separate production suite passes with 21 Luna requests: pure chat without
  a VM, real coding and authenticated preview, warm reuse, background-process
  survival, isolation and recovery of the 1,024-file fixture onto a fresh VM.
  The evidence records observed total file counts before and after that Run.

[Bounded evidence](input-admission-20261010.json) records artifacts, outcomes and
preservation checks. Private operator reports remain in
`dist/releases/input-admission-db0548b8/`. This is not a throughput or HA benchmark.

## Preservation and completion

All owned test accounts, Sessions, Runs, Workspaces, projects and image objects
are removed after confirmed physical cleanup. Exact metadata for the foreign
isolation fixture is removed without deleting its original tenant. Final native
inventory covers 1/1 nodes with zero VMs; no open writers or pending controls
remain. Web/admin/Control Plane readiness return HTTP 200 and both Workers are ready.

Before/after configuration fingerprints match, excluding access/update timestamps
and version counters. The original 29 users/tenants, 30 model profiles and credential
bindings, four password-credential rows and 29 API credentials remain. Platform
runtime settings are preserved. The walkthrough checkpoint remains initial-message
PG acceptance; Worker claim/lease admission is still the next hop.
