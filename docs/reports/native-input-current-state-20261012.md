# Native input current state: implementation and release

Implemented and deployed under [ADR-0243](../adr/0243-native-input-current-state.md).
Product source: `e82d00b752cfa3b24558960d1a96335bb37ed6c4`.
Release: `native-input-current-e82d00b7`, Helm revision 37, schema 185.
Guest input / Tool Worker / Cube management protocols remain 4 / 4 / 7.

## Behavior

Pi still owns submissions, Inbox order, edits, cancellation and consumption.
Complete native batches are acknowledged by the existing RF3 Kafka path before
Pi adopts their state. PostgreSQL stores all Submissions and the conversation-scoped
latest-only `pi.inbox` / `pi-cloud.human-inputs` documents in `pi_durable_current`.
Their intermediate bodies are absent from the permanent native journal and the
64-delta document checkpoint index. Native version, delta count, creation/retirement
identity and cloud provenance survive materialization and cold reads.

The Projector co-commits current replacements, retained history, indexes and the
receipt. Removing an Inbox item, placing its Submission and appending its user
Entry therefore remain atomic. Individual cancellation clears unused text/upload
metadata through Pi, retaining stable identities and mutation receipts. Stop-return
pages and consumed-message presentation data keep their existing semantics.

Current input state is recovery data. Index rebuild leaves it intact, validates
its latest required checksums and reconstructs indexes from it plus retained history.
Missing bodies fail reads/rebuild rather than silently turning into an empty queue.
Retained-history counts and checksums also repair review finding R11L-01. The checksums
detect incomplete/changed recovery data; they are not signatures or another authority.

The hot projection watermark and touched current-state reads share one query.
The existing unrelated-document test still observes three SELECTs, rather than
introducing a separate metadata round trip. A materialized PG value wins over an
equal-position delta still in the Worker's acknowledged overlay.

This release does **not** implement the separately discussed `pi.live` Kafka-only
streaming policy or reclaim Task/rewindable-document history. Those remain explicit
follow-up decisions. Session-scoped image retention also remains conservative:
removing one queued reference does not authorize deleting a shared image.

## Source verification

| Check | Result |
| --- | --- |
| Workspace typechecks | Passed; final affected Storage typecheck repeated after the overlay fix |
| Workspace tests | 1,688 passed after repair of the schema-count assertion; 9 existing gated tests skipped |
| Storage contracts/current-state recovery | 65 checks in the final workspace run, including upstream contracts in overlay and cold PG modes |
| Native input API | 19 checks; submission/edit retry, promotion, ordering, consumption races and Stop-return |
| Operator helpers / asset recovery | 64 passed; source removal, real PG/image restore and current-state preservation/rebuild |
| Kafka transport | 7 passed |
| Targeted fault evaluation | 240/240 passed; deterministic fault injection, not a fleet chaos claim |
| Dependency audit | Passed, no remaining reported vulnerabilities |
| Build/install/Helm/runtime/image-closure gates | Passed |
| Matched artifact scans | 11 images passed the existing zero-fixable-HIGH/CRITICAL gate |

The first full CI run's only failure was the database test still expecting 184
migrations. Its corrected schema-185 test passed separately. Remaining helper,
transport, fault and security gates completed after that run. Raw evidence is kept
privately under `dist/releases/native-input-current-checks/`. Fault evaluation ran
on the pre-commit working tree (its report records `afbe3667` plus dirty state);
the implementation was subsequently committed as the product source above.

One fixture edits an Inbox 130 times, crosses local eviction/PG catch-up boundaries,
preserves NUL/lone-surrogate text and native delta counts, and retains only two
current bodies (Inbox and Submission), with no queue history/checkpoints. It tests
old replay, changed replay rejection, failed consumption rollback, committed
consumption and index deletion/rebuild. Additional cases reject missing/changed
current/history data, verify retirement/replacement, and isolate unrelated scopes
sharing the same document kind. These establish the retention contract, not fleet
throughput or a guarantee that PostgreSQL WAL/MVCC stores no temporary versions.

## Deployment and live acceptance

The maintained prepare/apply workflow built and scanned the matched images, drained
writers, confirmed native VM absence and deployed the matched applications/schema.
The first preparation stopped at the dirty-worktree scan guard because the concurrent
fault evaluator had generated its tracked reports. Those reports were preserved
privately; preparation was repeated from clean source in a fresh candidate directory.
No gate was bypassed and no serving cutover occurred before successful preparation.
A temporary loopback relay bridged the build host's stale Docker proxy port to its
existing proxy; it was stopped before apply. Host proxy configuration was not changed.

All live model tests used GPT-6 Luna:

- Native consume/Stop/recover scenarios passed: one cloud Run, stable retry identity,
  edited text, ordering, promotion and no retained old input bodies.
- The recovery case killed the fixture's real Worker process. Kubelet confirmed exit
  code 137; the same Run resumed after ordered closure and consumed its queued inputs.
- Real browser lost-reply/Stop/returned-image/resubmission passed, retaining the same
  upload identity and direct model vision.
- Large Read passed with 51,200 ASCII bytes and 51,196 valid UTF-8 bytes returned,
  preserving canonical truncation diagnostics.
- The full production suite passed pure chat without Cube activation, real file/shell
  work, authenticated preview, warm cross-Run reuse/background processes, tenant
  isolation and 1,024 persistent files restored into a fresh Cube VM.

The first browser/Read run timed out in the post-Read model response. Gateway evidence
shows HTTP 200, first text at 2.75 seconds and 3,398,149 streamed bytes over 234 seconds
before test cancellation. This was prolonged text output, not an idle connection;
the exact reason for its length is not established. The operator fixture now asks
for two exact short labels instead of the ambiguous “WIDE identifier.” Its deadline,
actual Tool-result byte checks, UTF-8 checks and diagnostics were unchanged; the
repeat passed. The initial failed report and bounded timing metadata remain private.
The full production driver also explicitly selects Luna for its owned sessions,
independent of platform defaults. These later edits affect operator tests, not the
deployed product images.

## Cleanup and limits

Both targeted drivers confirmed their owned tenant/image/Workspace cleanup. The full
suite's three projects were identified against the pre-test inventory, their Workspace
bytes were confirmed purged, and native inventory proved 1/1 nodes scanned with zero
VMs before fixture metadata was discarded. Final Runs, Sessions, projects, Workspaces,
native commits, writers and active resource counts are zero; these were disposable
acceptance fixtures. No pre-existing business history needed deletion for the cutover.

Original users/tenants/model profiles/provider bindings/password credentials and
platform settings retain their fingerprints. API credential stable fields match the
previous release's stable-field baseline; the cross-tenant test legitimately updated
the bootstrap credential's `last_used_at`, so its whole-row fingerprint changed.
Final counts are 29 users, 29 tenants, 30 model profiles, 30 credential bindings,
29 API credentials and 4 password credentials. Control Plane readiness and Web return
HTTP 200, and both Workers are Ready.

Private candidate/live evidence is under `dist/releases/native-input-current-e82d00b7/`.
The asset recovery procedure still requires quiescence; this does not add live backup,
physical-node HA or arbitrary Tool replay. The private-use pilot remains a separate
actual-use/capacity gate.
