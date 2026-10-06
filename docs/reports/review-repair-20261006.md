# Post-Durable review repairs

Source implementation follows the owner's approval of the
[October 6 review](repository-review-20261006.md), preserved at `48cd4366`.
Validation is in progress. No production deployment or schema migration has been
performed by this repair task; deployed baseline evidence is in the review report.

## Implemented slices

- R06-01: restore Compaction summarize/retry request identity from persisted live
  Tasks before binding a fresh PG grant. Remove unused saved hook API/context.
  Native scheduling, model authorization and unsafe Tool recovery stay unchanged.
- R06-02: track message start/end state through overflow snapshots, keep a recovered
  old partial outside the next sampling identity, and associate retry progress
  emitted before terminal-only message events. An active Tool query recovers its
  committed proposal without revealing uncovered text from that assistant.
- R06-03: replace the PG advisory lock with filesystem-held exclusion under
  [ADR-0231](../adr/0231-volume-filesystem-mutation-locks.md). The callback's open
  descriptor retains the lock despite PG connection loss; acquisition utility exit
  does not release it. Replaced inode waiters are rejected. Remove the obsolete PG
  lock, pool dependency, tests and archived standalone reproducer. Gateway rollout
  uses `Recreate`; PG remains responsible for upload/lifecycle authorization.
- R06-04: [ADR-0232](../adr/0232-indexed-native-navigation.md) adds thin navigation
  classification, scoped/paged body reads, and full-prefix streaming for human
  Forks. No Tool result body is copied into a second query store. Fork context,
  original IDs, documents and attachments survive bounded copy batches inside one
  administrative transaction. Current public tree response bounds remain unchanged.
- O06-01/02: batch record indexes and derive document revision metadata inside the
  INSERT. Read a definition/tail only when a 64-delta checkpoint requires it.
  Fixed JSON selector keys are allowlisted literals; values remain parameters.
  Schema 181 backfills navigation/document policy without coercing native bodies
  to JSONB. Constraints refuse outdated projector metadata instead of hiding rows.
- O06-03: adopt only the MIT-licensed Pi 1.0.0 head/tail truncation helper subset,
  with source SHA-256 and 1,100 results captured from the original published helper.
  No private production import or Agent-loop patch is used. Remove the complete
  CLI dependency and its obsolete brace-expansion replacement/audit exceptions.
  Preserve the independently required json-ext merge correction in a named parser
  preparation script. Bundle closure now excludes CLI, TUI, MCP, Codemode and
  Provider SDKs.
- Q06-01: migrate the real Kafka Subagent fixture to native Task IDs and the
  existing native family/Conversation preparation fixture. Validate that identity
  before Kafka admission and reuse the parser at control boundaries. Promote the
  isolated RF3 integration runner to `npm run test:transport` and include it in CI.
- Q06-02: pin `source-map-js` 1.2.2; the current dependency audit reports zero
  remaining vulnerabilities, without suppressing findings.
- R06-05: reconcile maintained cancellation, queue and partial-persistence guidance
  with Durable. Mark old queue-pause and evaluation instructions as historical.

One review claim was narrowed during implementation: native Pi emits a synthetic
`message_start` for an ordinary terminal-only response. A pure Tool response alone
does not prove that event is absent. The confirmed missing-start path is overflow
snapshot reconstruction; native retry progress can also precede terminal-only
entry events. The regression tests now describe those actual boundaries. The cold
Tool query coverage gap is independently tested.

## Verification observed so far

- Native compaction recovery, abort/grant refusal, event snapshots/retry ordering
  and uncovered Tool queries pass targeted tests.
- Filesystem locking: seven tests pass, including separate process holders,
  SIGKILL, PG disconnection, timeout, replaced inode, credentials and deletion.
- Native Storage/tree/attachment checks: 79 assertions pass; the added projection
  query contract passes with the 56-test Storage contract file.
- Isolated three-broker Kafka + PG: 7/7 integration assertions pass, including the
  previously failing Subagent view. Ordinary ingress append and hot binding reads
  still show zero SQL in their named measured scopes.
- Truncation/guest/dependency helper checks: 64 assertions pass. npm removes 149
  packages and updates one. Guest `envd-tool-exec` is 775,103 bytes versus the
  baseline 8,782,025; this is bundle size, not a startup-time measurement.
- Same Tool-heavy navigation fixture: one returned node now fetches one 195-byte
  body instead of 258 bodies / 1,107,460 bytes. Single document-delta projection
  uses eight SQL statements including BEGIN/COMMIT instead of ten. The forced
  generic plan now uses the Conversation index; default samples remained custom.

The first concurrent PG fixture run exceeded a test's ten-second setup timeout;
the serial run with explicit setup budgets passed. A PG-loss fixture initially
left a second disconnect event unhandled; the test listener was corrected and the
seven-case file was rerun successfully. Neither failure was hidden as a product pass.

Full workspace/fault/delivery verification is recorded when those checks finish.
The changes require matched Control Plane/schema 181, Worker, Volume Gateway and
guest-image release. The two existing UNKNOWN runtime records and production
conversations/Volumes have not been reset or destroyed. Physical multi-node
filesystem failover remains a deployment-specific acceptance requirement.
