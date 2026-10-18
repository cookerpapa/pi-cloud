# ADR-0255: Native result limits and metadata-only settlement observation

Status: accepted, implemented, deployed and verified, 2026-10-18. See the
[delivery record](../reports/worker-harness-settlement-repair-20261018.md).
Following the
[Worker → Pi review](../reports/worker-harness-settlement-review-20261018.md),
the owner chose Pi's native default limits and approved WHS-01/02/03 repairs.
This supersedes ADR-0196's 256 KiB result budget, retaining its explicit
oversize-error and no-automatic-replay rules. It does not change Subagent input
budgets, execution authority, native settlement or storage ownership.

## Result admission

Use the pinned Pi Durable 1.0 default of 50 * 1024 UTF-8 bytes and 2,000 lines
for coordination Tool text. A trailing LF terminates the last line rather than
starting another. Strings retain their representation; other return values are
serialized once to the text actually returned to the Harness. JSON escaping in
the outer transport envelope is not the native text budget.

An over-budget coordination result or error becomes an explicit bounded Tool
error, with guidance to inspect existing effects and return a summary/Workspace
path. Do not turn structured results into successful incomplete JSON. Keep the
Harness defaults unchanged and preserve fixed Read/Bash truncation behavior.
The guest workflow wrapper and trusted receiver use the same admission semantics;
contract tests compare boundary results with the pinned public native Harness.

Supervisor results retain useful metadata but remove duplicated `output` and
`replyMessage` fields already represented by the selected text. Bound the remaining
metadata's serialized representation with the same budget. Workflow hostcalls
validate their actual returned value before adding the small execution-reference
wrapper; they are not another native Tool result. This prevents duplicate metadata
from unnecessarily halving the allowed text and retains the existing whole-fact
900 KiB safety boundary. Add exact-byte/line, Unicode/escaping, structured-result,
large-error and actual-native-finalization tests. No legacy 256 KiB mode remains.

## Committed observation

Keep canonical Tool display in its existing native commit. If a native observer
event generates no outgoing PiCloud bodies, do not read its Entry or sequence.
Continue advancing observed Entry progress so settlement cannot hang.

`recordSequence()` reads acknowledged metadata from existing memory when present,
or selects only `seq` from the tenant/Session-scoped native record index after
eviction. It must not join history bodies, restore images or populate another
cache. Preserve the Storage serialization, failed-owner and cold-watermark rules.
Verify metadata reads with the blob port unavailable and hold publication ACKs to
ensure no unacknowledged state becomes visible.

## Result shape

Replace unrestricted content arrays with PiCloud-owned text/image structures.
The fixed guest/native result carries text or normalized inline image parts;
the Kafka reply carries text or immutable image references. Keep these schemas
and their return types distinct. Empty content, structured diagnostics and opaque
details remain supported. Validate before recording known execution settlement.

Use the existing protocol-error classification for an identifiable invalid
mailbox result. Strict publisher/consumer parsing rejects malformed wire data;
generic Kafka decode-failure ordering is unchanged. No permissive fallback,
new signature, lease check, result ledger or automatic replay is introduced.
Image integrity/read failures after a valid receipt keep ADR-0254's separate
attachment semantics. Native Pi remains the canonical Tool Result authority.

## Verification and release

Move review characterizations into maintained regressions and archive the old
bug expectations in Git. Verify real native result/task/live atomic commits,
before/after-commit recovery without unsafe replay, Stop/late replies, strict
native/packed shape contracts and real PG cold metadata reads. Run affected
packages/types, repository, RF3 transport and fault gates.

Deploy through the maintained matched release after artifact scans and positive
writer/VM drain checks. Valid wire layouts and schema remain unchanged; the
matched cutover updates validation and result semantics together. Use GPT-6 Luna
for live coordination/workflow limits, ordinary Tools, images, Stop and recovery.
Physically clean owned fixtures before deleting their metadata, and preserve
original accounts, models, providers and credentials.
