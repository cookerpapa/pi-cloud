# Run identity and local capacity — September 19, 2026

Implements [ADR-0180](../adr/0180-run-identity-and-session-ownership.md).
Completed early September 20 (Asia/Shanghai). Implementation `e41cd23e`,
production wiring correction `29ad0e2e`, final
execution/schema/template revision `f9ebe6af`. This is the approved admission
simplification, not a new whole-product audit or an enterprise capacity claim.

## Simpler authority

Worker pending/active family reservations are the sole slot accounting. PostgreSQL
no longer updates `sandboxes.active_sessions` or a `leased` occupancy state.
Worker registration, liveness and draining remain durable, not local capacity.

A Run executes once. RunAttempt, its state machine, current-attempt pointer and
counter are removed. Run owns publication, release and seal evidence. A failed
execution remains failed; continuing creates another Run, never replays the old
Tool. SQL transaction retries are not Agent execution retries.

One physical Session still has one Worker and Session Lease/Fence across concurrent
Lanes. The native writer ID is the lease incarnation, not a first task. Released
leases retain writer-closure evidence. Same-Lane readiness and old-owner closure
remain authoritative; Workspace input/deletion coordination is retained without
serializing users' filesystem work.

The ordinary elastic path now measures **8 input + 10 admission SQL exchanges**,
down from **8 + 16**, and previously 41 total. BEGIN/COMMIT are included; these
18 exchanges are still two admission transactions, not 18 disk syncs. The claim
has eight SQL statements: candidate/context, frozen configuration, physical
Session lock, product Session lock, Worker liveness lock, current lease read,
lease/epoch creation, and the final running/publication write. A sibling using
the existing owner need not create another lease. There is no slot-counter write,
Attempt insertion or separately committed claimed/startup phase.

## Paid latency comparison

One WSL host; one Pi Worker, PostgreSQL, three Kafka brokers and CLIProxyAPI.
Both cohorts use real GPT-5.6 Luna, medium reasoning, Standard service: 15
sequential short replies over one persistent SSE connection, excluding the first
three warm-ups. Baseline CP/Worker `d651a5a7`; simplified Worker `29ad0e2e` and CP
`e41cd23e`. No builds, test suites or isolated test database ran during timing.

| Warm 12 samples, median / p95 | Before | After |
| --- | ---: | ---: |
| API acceptance | 15.58 / 21.28ms | 19.21 / 32.90ms |
| Worker admission | 21.27 / 41.77ms | 13.63 / 29.82ms |
| Submit → provider dispatch | 72.99 / 104.75ms | 73.34 / 105.87ms |
| First text excluding provider route | 81.71 / 112.16ms | 83.38 / 113.33ms |
| Entire Turn excluding provider route | 149.97 / 392.05ms | 155.70 / 328.00ms |
| Provider completion → terminal receipt | 72.75 / 318.43ms | 82.27 / 245.38ms |

Admission median improved about **36%**, but end-to-end internal latency did
**not** materially improve in this bounded comparison. Acceptance and terminal
variation offset the smaller claim. Remaining tails must not be attributed to
Kafka, WAL or a device solely from these aggregate spans. No outlier was removed,
durability weakened, or host power setting changed.

Medians average the middle pair; p95 uses nearest rank. Whole-Turn subtraction
uses each request's provider duration, not the sum of independent medians. The
provider route includes CLIProxyAPI. SSE receipt is not browser DOM paint.

## Correctness and real failures found

- The first deployed Worker still passed an old display label where admission
  now requires its registered UUID. The accepted input stayed queued; no Agent
  executed. Wiring now uses the UUID directly, with a boot/restart regression.
  After replacement, that same accepted Run completed once. Its outage wait is
  excluded from the separately created latency cohort, not hidden as a fast sample.
- Initial coding used a pre-cutover Cube image whose bundled operation schema
  still required `attemptContextSha256`. Tool requests failed; this was not a
  successful coding run. The matching template was rebuilt, its real envd
  file-write/Bash contract passed, and coding was repeated on fresh Workspaces.
  There is no old-protocol decoder. Deployment instructions now explicitly
  include the guest image in this non-rolling upgrade.
- Dropping the old Attempt column also dropped environment-validation uniqueness.
  Migration 146 restores `(environment_version_id, run_id)` uniqueness. A real-PG
  regression now executes environment-failure settlement and seal projection.
- Final review removed duplicate Run fields/predicates left by identity merging.
  Native Session deletion removes retired owner evidence only after quiescence;
  the regression rejects deletion with unsealed work.

The schema migration was applied after all inputs, owners and seals drained.
A private restore of the pre-migration PG dump confirmed all **265 native log
rows** unchanged by migration 145. PostgreSQL, Kafka and Cube were not restarted
for the schema deployment. This checks migration preservation, not whole-system
disaster recovery.

## Functional and process-fault acceptance

- A pre-migration Session recalled its marker on the replacement Worker.
- Cube wrote and ran insertion-sort assertions, then binary-search assertions.
  The second Turn preserved the first file byte-for-byte; 2 and 3 successful
  Tools respectively, with actual Python execution.
- Cancellation settled in 617ms; the same Session accepted and completed a
  new Run afterward.
- A Cube-isolated workflow started inherited-context and fresh-context children.
  Both returned the expected different answers and shared the parent's physical
  Session, Worker and Session lease. Parent completion awaited both children.
- Three queued follow-ups completed FIFO, each admitted after its predecessor's
  committed seal. Four concurrent Sessions across two tenants returned their own
  markers; cross-tenant history access was denied.
- After 100 visible characters, a follow-up was accepted, then Control Plane
  and Worker were SIGKILLed. PostgreSQL/Kafka stayed alive. The visible prefix
  remained exact; the failed Run had one admission, released authority and a
  projected seal. Recovery took 21.03s, including 12 expected SSE reconnect
  attempts. The preaccepted follow-up then completed on a new Worker boot and
  lease, strictly after the old seal. No old Run was retried.

There were **51 owned test Runs** and no repeated admission. Two failed Runs are
accounted for above: the mixed guest protocol and the injected process crash.
Pi-native usage recorded **58 provider responses**, 88,900 input, 311,808 cache-read
and 2,864 output tokens. Aborted requests without final usage are not included.
These are actual model calls, not a mock-model throughput estimate.

## Verification and cleanup

The final full package sweep passed **1,111 tests in 175 files, zero failures**
(601 seconds), with three
explicit opt-in skips (Kafka topic-policy and two Cube live security cases).
The targeted PG/Tool suite passed 65 tests. All workspace type checks, formatting,
docs, build, deployment/Helm/runtime-budget/image-closure checks, observability
validation and 30 acceptance-helper tests passed. The 34-case deterministic fault
gate passed before the final wiring/validation corrections; it is distinct from
the live process-fault test above. The full-sweep migration-count fixture initially
still expected schema 145; both ledger assertions were corrected to 146 before
the final successful sweep. The existing large frontend bundle warning remains.

Six owned test tenants, eight top-level conversations, two child views, six
Workspaces and their volumes/runtime records were deleted through product APIs
and a guarded tenant-scoped purge. Original accounts/history remain 33 tenants,
35 users, one Session and seven Runs. Kafka v9 was retired
only after all its Runs were sealed and projected; current Kafka retention and
official service logs are not indiscriminately cleared.
The isolated test PostgreSQL container/volume and its newly pulled image were
removed, along with 24 owned temporary scripts, raw reports, credential registry,
read-only volume-inspection copy and migration backup. The aggregate evidence
above is retained without test transcripts or credentials.

The owner subsequently authorized destruction of the original UNKNOWN machine
and its Workspace bytes. The old binding was rejected by the new protocol, so
cleanup used Cube's exact instance identity rather than a compatibility decoder.
Cube confirmed the instance absent, but its volume's master reference count stayed
at one. The live Cube inventory, host VM/virtiofs process inventory and node bbolt
volume-reference bucket were all empty. A one-off repair of only that authorized
volume's stale master counter let the ordinary Workspace deletion reaper finish.
The operation was not installed as a runtime fallback. No active development
machine or unpurged Workspace remains; the conversation is retained for rebinding,
and temporary maintenance credentials were removed.

Cube's ordinary old-template retention deferred four deletions during registration
(one then-in-use template, three cleanup timeouts). This older upstream resource
bookkeeping issue is separate from successful new-template execution; it does
not justify bypassing live-volume checks in PiCloud.
