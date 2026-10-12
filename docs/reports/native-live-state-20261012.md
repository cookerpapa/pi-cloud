# Native live state: implementation and release

Status: deployed as `native-live-1370d871`, schema 186, under
[ADR-0244](../adr/0244-kafka-backed-native-live-state.md). Source gates and the
focused live-state, native-input, browser/image and multi-Conversation acceptance
pass. The broader Cube production check also passed on October 12 at 05:23 UTC.
Earlier model requests encountered upstream TLS handshake failures; those failed
executions and the successful follow-up remain separately recorded below.

## What changed

Pi still commits complete native batches through the existing ingress and RF3
Kafka. The Worker adopts a batch only after that acknowledgement. A native
conversation's `pi.live` body is now materialized in Worker/Projector memory;
its streaming changes no longer enter the PG journal or the generic 64-delta
checkpoint index. PG retains the small native commit headers and state digests.

The existing `pi_durable_current` table holds a complete boundary/handoff
checkpoint and nullable Kafka recovery coordinates. The first uncheckpointed
change installs its reference. Native settlement replaces the checkpoint and
clears the reference atomically with the batch's other facts. Writer closure
requires replay through the native head and commits an exact checkpoint before
admitting replacement. The adapter preserves native version and delta count;
materialization never allocates native sequence or creates an Assistant Entry.

Ordinary Worker buffer flushes retain active live values. Projector replay
reconstructs already-projected updates, including accepted updates from a closed
Run anchor; stored fingerprints and cutoffs separate that operation from new
write/effect admission. Replay references also constrain Kafka deletion across
Conversation/Run boundaries. Missing recovery ranges, incomplete handoff and
changed checkpoint data fail explicitly.

The current-state helper is shared with ADR-0243 input storage. No new table,
queue, broker, lease, consumer group or background task scheduler was introduced.
Tool dispatch/cancellation, native input ownership, image references, model
Compaction and frontend event coverage retain their existing boundaries. The
separate Kafka representation of display text remains a follow-up optimization.

## Verification

| Check | Evidence/status |
| --- | --- |
| All workspace typechecks | Passed across 22 workspaces |
| Workspace tests | Full run: 1,692 passed, one SQL-budget failure, nine existing gated skips; that failure was repaired and its focused regression passed |
| Additional storage verification | Latest full file: 70 passed, including two cases added after the full workspace run; combined workspace coverage is 1,695 passing cases |
| Native state failure cases | Buffer flush, replay gaps, duplicate/changed records, lost ACK poisoning, SQL/checkpoint rollback, JSON edge cases, large Kafka offsets, two interleaved Conversations and exact cold restoration |
| Closure/retention | 13 closure cases, including blocked incomplete handoff and a protected suffix after its Run anchor closed |
| Projector handoff | 15 existing handoff/effect-boundary cases passed |
| Operator helpers/assets | 64 passed, including real PG/image restoration and incomplete-restore safeguards |
| Real PG/Kafka transport | Seven cases passed |
| Deterministic fault evaluation | 247/247 passed, including seven new native live-state cases |
| Release source gates | Format/docs/build, install/runtime policy, Go admission/allocation, Helm, observability and image closure passed |
| Dependency audit | Passed with no remaining reported vulnerabilities |
| Matched artifacts | All 11 image scans and matched preflight passed |
| Native input/live acceptance | Five scenarios passed, including Stop and loss of both Worker and Projector memory |
| Browser/image/Read | Lost acknowledgement, Stop/return, image resend/direct vision and oversized ASCII/UTF-8 Read passed |
| Multi-Conversation | Supervisor interaction, messaging, parallel children, cancellation and guest boundary: five passed |
| Full Cube production check | Follow-up passed on the unchanged deployed release at 05:23 UTC, including fresh-VM Volume restoration and confirmed allocation cleanup |

The first full run exposed an extra initialization SELECT. Projector live
bootstrap now shares its existing native-head/current-state query; the original
ten-statement first/next projection expectations pass without raising the budget.
Cold Worker completeness is also checked in its existing native-head query.
Two partial indexes support recovery floors and per-Session pending-state reads.

An initial image-Harness fixture used no synthetic Kafka position and could not
admit live progress. It was updated to exercise the same ordered-position contract.
An added interleaving test initially compared two separately timestamped faux
messages; it now compares the exact original message. Neither fix weakens the
runtime retention/recovery checks.

The initial fault run had 224/240 successful mapped cases because the temporary
baseline archive also contained old tests. Root-level Vitest discovered those
duplicate paths and failed their archived tsconfig lookup while the actual
target assertions passed. The temporary test copies were moved out of the
repository; baseline extraction now documents source-only paths. The complete
rerun, expanded with seven new live cases, passed 247/247. The failure evidence
is retained privately; no evaluator success condition was relaxed.

## Isolated storage measurement

The retained probe is
`scripts/experiments/native-live-20261012/measure.mjs`. It runs against a disposable
official PostgreSQL container, never a production URL. The baseline adapter was
extracted from `72cbe218`; both variants used the same native writes and schema
fixture. The 1,001 updates contain an initial generation state and 1,000 native
string appends, producing 257,000 text bytes.

| During generation | Previous adapter | New adapter |
| --- | ---: | ---: |
| PG live journal bodies | 1,002 | 0 |
| Live journal body bytes | 379,334 | 0 |
| Derived full checkpoints | 15 | 0 |
| Derived checkpoint bytes | 1,978,320 | 0 |
| Current PG baseline bytes | 0 | 197 |
| Native commit headers | 1,002 | 1,002 |
| Counted adapter SQL statements | 6,051 | 4,005 |
| Observed WAL bytes | 2,467,584 | 589,048 |

These are initial isolated samples, not production throughput claims. The probe
excludes Kafka networking, Run authority checks, provider work and driver
BEGIN/COMMIT statements. Other repository checks were running on the host.
Generation-loop time was about 10.2 versus 11.1 seconds; duplicate replay plus
exact cold read was about 5.7 versus 8.4 seconds. Sampled heap peaks were about
59 versus 121 MB, including transient allocations; these are not retained-state
sizes or fleet memory estimates. Reconstructing and checking the complete current
value has a CPU/memory cost. The demonstrated gain is less PG payload/SQL/WAL
work, not a demonstrated improvement in overall latency.

After simulated handoff the new adapter stored one 258,245-byte exact recovery
checkpoint. After normal completion it returned to a 197-byte live baseline;
the final Assistant Entry remained canonical. Both variants restored identical
text and native delta counts. Private JSON reports retain all measurements.

## Deployment and live acceptance

The maintained `prepare`/`apply` workflow deployed application source
`1370d871557caca20c0f6daec9bda5a7967fc703` as `native-live-1370d871`.
The application Helm revision is 38, schema is `186_native_live_checkpoints`,
and guest input / Tool Worker / Cube management protocols remain 4 / 4 / 7.
The guest input identity is `70d59dfbeb18c8b31d63048f38cadeb9deb93ea8`;
the Cube completion identity is `4cf0beea09fe17bc3557adc18dfc80ebec49dbf6`.
Acceptance-only script corrections and these release notes follow the runtime
commit; they do not change its served images or protocol.

The first preparation stopped while downloading Trivy's database. Downloading
the same scanner's database from its official public ECR repository succeeded.
All 11 maintained scans and matched artifact verification then passed. The
security gate was not bypassed. The temporary build proxy was stopped.

The pre-release observation found no business Runs/Sessions/Workspaces/native
commits or active VM/writer/terminal resources. No existing business data needed
removal. Apply still drained writers and required positive native VM absence
before the matched schema/app/Cube cutover. No compatibility reader remains.

Real GPT-6 Luna acceptance passed:

- Native input consumption, editing, ordering, steer promotion and retry identity;
  Stop returned pending inputs, and an actual Worker SIGKILL recovered the same Run.
- Streaming Stop observed 324 characters through SSE; dual-process failure
  observed 259 characters. Both checked the first 100 displayed characters in the
  native aborted Assistant Entry. During generation PG contained neither live
  journal/revision bodies nor an in-flight generation in its baseline. Final
  closure cleared the Kafka replay references.
- The simultaneous-memory-loss case suspended the Control Plane, killed the
  actual owning Runner, then killed the Control Plane. Kubelet confirmed exit
  137 for both. Recovery kept the logical Run and preserved the checked text.
  Exact full native state, including delta counts, is additionally checked by
  controlled storage/replay tests rather than inferred from the UI prefix.
- The real browser exercised a lost admission reply, Stop, returned image identity,
  resend as a new input and direct vision. Guest Read retained valid UTF-8 and
  canonical truncation diagnostics at 51,200 / 51,196 bytes for the two fixtures.
- Five Subagent scenarios passed: supervisor interaction, messaging, two parallel
  children, cancellation and guest boundary. Parent/child Conversations retained
  the same physical Session, Worker and lease.

The first streaming fixture incorrectly waited for active text through the
canonical history endpoint. Its three input cases passed, but the streaming
observation timed out; cleanup completed. The driver now uses the browser's
existing SSE client and reducer. Their 38 tests passed, followed by all five
real native-input/live cases. No application change was needed for this fixture.

## Earlier broader acceptance failures

The initial full Cube production executions did **not** complete successfully.
The first read the generated Python file but failed an
artifact assertion requiring the word `negative`, which the prompt had not
specified as a marker. The prompt now explicitly names `test_negative_inputs`;
the original assertion remains unchanged and passed on subsequent executions.

Four subsequent executions failed at model requests. The first two coincided
with model-proxy HTTP 500 responses after approximately three seconds; their
native error explanation was not retained by the old diagnostic. The next two
captured `utls: TLS handshake: EOF`. The egress audit for a matching failure
records `upstream_ended` at 3,004 ms. This confirms an upstream tunnel closure;
it does not identify why the upstream proxy or remote endpoint closed it.
Six direct ordinary and six direct streamed Luna requests succeeded, as did
the focused native/browser/Subagent suites, so the failure is intermittent.

Across the broader runs, pure chat without VM activation, real coding, Volume
files, authenticated preview, warm-VM reuse, surviving background processes,
tenant isolation and the initial 1,024-file fixture passed. The most advanced
execution confirmed removal of the source VM, then its fresh-VM follow-up failed
at a model request. These partial observations are not a replacement for one
complete production-suite pass. The successful later run below closes the
acceptance gap; the intermittent upstream cause remains in the Backlog.
No runtime retry policy, model/provider
configuration or storage acceptance condition was changed to hide the failure.

The production driver now captures bounded outcome, HTTP status and known
transport-error categories before deleting its fixture history. It does not log
free-form provider errors, native model content, Tool arguments or credentials.
Failed and successful acceptance artifacts, including the earlier diagnostic
containing the redacted TLS error, remain in the private release directory.

## Successful full Cube follow-up

At `2026-10-12T05:23:01.872Z` the maintained `production:check` driver completed
with `accepted: true` and exit 0. Its source was
`80ad4b3bba3b6d87d1f48d6a66bf1d029713c719`, including the previously recorded
acceptance corrections. Serving artifacts remained `native-live-1370d871` /
schema 186; this follow-up did not modify application code, model configuration,
credentials or retry policy. The Control Plane image ID was
`sha256:ef72916dd737eb2825b356d728f2cc7d393b02de3615a88a34c925f5866be27d`.

The [full generated acceptance report](cubesandbox-production-acceptance-latest.md)
and its JSON evidence record pure chat with zero Tool/VM activation, real coding,
persisted files, authenticated preview, warm-VM reuse across distinct Tool
bindings, surviving background work and cross-tenant isolation. After confirmed
source-VM removal, the 1,024-file fixture was available on the same Volume in a
fresh VM with a higher runtime generation. Total file counts were 1,025 before
replacement and 1,026 after the follow-up's additional marker. Final-conversation
deletion and confirmed native allocation closure both passed with zero retained
test VMs. The suite made 20 real GPT-6 Luna requests.

Before this run, eight ordinary Node TLS handshakes through the existing egress
path succeeded. They use a different TLS client from CLIProxyAPI's uTLS; neither
those probes nor this successful suite proves the earlier intermittent tunnel
closure has been fixed. The original failures remain available for diagnosis.

The subsequent [TLS investigation](model-egress-tls-20261012.md) reproduced the
same three-second EOF directly through the local proxy, bypassing PiCloud,
and separately captured an AnyTLS node-connect timeout. Its 1,001-update storage
recheck also confirms the current PG/Kafka retention split.

Private follow-up evidence is under
`dist/releases/native-live-cube-20261012-0519/`. Its scoped cleanup removed the
owned acceptance tenant and all three fixture projects only after confirmed
Volume purge and native absence on 1/1 nodes. The final business/resource counts
returned to zero, original account/configuration and stable credential-field
fingerprints matched the new pre-test baseline, and Control Plane/web/Workers
retained their 1/1, 1/1 and 2/2 Ready replicas.

## Cleanup and serving state

All successful and failed owned fixtures were settled and deleted through the
existing APIs. Cleanup waited for Workspace byte purge, closed control records,
and native inventory across all recorded nodes before deleting owned metadata.
The last native inventory scanned 1/1 nodes and found zero VMs. Original account,
configuration and credential records are checked separately from owned test
tenants; API credential usage timestamps may advance during bootstrap checks.

Final PG inventory matches the empty pre-release business baseline: zero Runs,
Sessions, Workspaces, projects and native commits, with zero active writers,
unsealed Sessions, VMs, development machines or terminals. Original counts remain
29 users, 29 tenants, 30 model profiles, 30 credential bindings, 29 tenant API
credentials, one platform settings row and four password credentials. Full
account/configuration fingerprints and credential fingerprints excluding
`last_used_at` match their pre-release values.

The Control Plane and web each have 1/1 Ready replicas; the Worker pool has 2/2.
Control Plane readiness and the web endpoint both return HTTP 200. Detailed
private evidence lives under `dist/releases/native-live-1370d871/` and source
verification/measurement evidence under `dist/releases/native-live-checks/`.
