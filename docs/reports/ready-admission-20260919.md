# Ready-Run admission acceptance — September 19, 2026

Implemented [ADR-0179](../adr/0179-ready-runs-and-single-admission.md).
Runtime change `9799117f`, cancellation correction `d651a5a7`; migration 144 is
deployed. Kafka v9, Cube templates, Volume bytes and execution semantics remain
unchanged. This is a scheduling/admission slice, not another full product audit.

## What changed

Accepted input is not automatically ready work. `runs.ready_at` materializes
the Lane head's dependency readiness during input acceptance or predecessor seal
projection, under the same Session row lock. Child preparation readies its own
Lane without waiting for the parent. Worker admission no longer scans predecessor
history again. Notifications only wake claimants; PostgreSQL remains authority.

Physical Session ownership uses its current owner and a transactionally maintained
unsealed-Run count. First Attempt insertion/first seal adjust that count; rollback
and duplicate seals cannot drift it. A healthy owner can run sibling Lanes; a
replacement owner still waits for every old Lane to close. Old committed-but-unbound
claim handling is removed from ownership, capacity and KEDA selection.

Admission reuses its locked/current rows across lease, publication and running
writes. Input/mailbox writes, lease/epoch writes and running-state writes use
dependent SQL statements rather than separate client exchanges. The ordinary
elastic-admission regression measures **8 input + 16 claim SQL exchanges**, including BEGIN/COMMIT,
instead of **10 + 31**. These are still two admission commits, not 24 fsyncs.
Exact ambiguous-COMMIT confirmation, post-lock time, capacity, fences and seals stay.

## Real Luna comparison

One WSL host, Compose Control Plane/Worker, PostgreSQL and three Kafka brokers;
real GPT-5.6 Luna, medium reasoning, Standard service through CLIProxyAPI. Baseline
runtime `4c7ff326`, candidate `9799117f`, final runtime `d651a5a7`. Each cohort used
one new tenant/Session and 15 sequential short replies over persistent SSE; the
first three warm-ups are excluded. No builds/test suites ran during timing.
Durability and host power settings were not relaxed.

| Warm 12 samples, median / p95 | Baseline | Final runtime |
| --- | ---: | ---: |
| API acceptance | 19.98 / 38.71ms | 19.20 / 39.81ms |
| Worker admission | 40.00 / 68.79ms | 24.71 / 30.80ms |
| Submit → provider dispatch | 102.15 / 157.54ms | 83.44 / 111.58ms |
| Native Session open | 16.28 / 27.92ms | 14.65 / 21.98ms |
| Provider route → first text | 3327.69 / 4040.25ms | 3199.59 / 4703.43ms |
| Pi text event → SSE receipt | 9.69 / 11.42ms | 8.56 / 9.50ms |
| First text excluding provider route | 113.40 / 167.02ms | 91.49 / 120.37ms |
| Entire Turn excluding provider route | 182.41 / 238.59ms | 155.84 / 457.65ms |
| Provider completion → terminal receipt | 80.47 / 92.78ms | 76.39 / 353.06ms |

Median claim improved about 38%; median non-provider first-text time about 19%.
The earlier candidate cohort measured claim 22.72ms and whole-Turn non-provider
149.53ms medians. These sequential one-host cohorts are bounded observations,
not a randomized capacity experiment or a latency SLO. Medians average the middle
pair; p95 uses nearest rank. Each whole-Turn sample subtracts its own provider
duration; independent stage medians must not be summed. SSE receipt is not DOM
paint, and the provider-route span includes CLIProxyAPI.

The final cohort's whole-Turn p95 **did not improve**. One 353ms terminal tail
remains: settlement/Outbox timestamp 11:43:34.357Z, publication .627Z, seal
projection .631Z. Claim for that Run was 24.74ms. This locates the excess after
model completion, across settlement/Outbox delivery, not in startup. Those
timestamps do not separate PG commit, relay claim, scheduling and Kafka delay;
this run does not establish a particular WAL/device cause. No outlier was removed.

## Correctness and failures encountered

The final full package sweep passed **1,106 tests in 172 files**, with three
opt-in test skips, on the corrected runtime (630 seconds). The related 57-test
suite and **32/32 deterministic fault gate** also passed on `d651a5a7`.
Workspace type checks, formatting, docs, Helm/preflight, image closure and build
passed; matching CP/Worker images built and were deployed.

Ready-work coverage includes both input/seal lock orders, closure rollback,
duplicate seals, same-Lane FIFO, final-sibling owner handoff, notification recovery,
capacity contention, cancellation and exact lost-COMMIT confirmation. Migration
guards reject a non-drained cutover.

Real testing found a cancellation deadlock: lifecycle `FOR UPDATE` held a Turn
while awaiting its Attempt; native projection held the Attempt and needed the
Turn foreign key's KEY SHARE lock. Cancellation became an `assignment_lost`
failure after about 60 seconds. Deterministic real-PG tests reproduced this cycle.
The correction uses NO KEY UPDATE for state-only lifecycle locks and retries
only certified SQL-aborted settlement transactions, never external stop/Tools.
Regression variants assert one external stop, one normal settlement attempt or
two attempts after an injected serialization abort. After deployment, cancellation
completed in 549ms and the same Session accepted the next message.

One deployment also recreated the PostgreSQL dependency. Broker's old ownership
lease expired and its three Tool attempts correctly failed closed; the assistant
nevertheless completed its explanatory reply. This was **not** a successful
coding test. After explicit Broker restart/readiness, both Cube coding Turns
passed. The deployment guide now documents targeted `--no-deps` replacement and
Broker readiness after database outages, without reviving expired authority.

## Paid functional and process-fault results

- An earlier Session retained its marker through replacement Worker boots.
- Real Cube wrote and executed insertion-sort tests, then binary-search tests;
  the second Turn preserved the first file byte-for-byte. Both final Turns had
  two successful Tools and actual Python execution.
- Workflow delegation returned the correct inherited marker and fresh-context
  response. Both child Lanes completed on the parent's physical Session, Worker
  and lease, before parent completion; no parent-seal dependency was introduced.
- Three accepted follow-ups completed in order. Each successor's claim timestamp
  was after the predecessor's committed seal.
- Four Sessions across two tenants overlapped four actual claim-to-settlement
  intervals. Replies remained attributed; a foreign-tenant history read was denied.
- During a live response, SIGKILL stopped both Worker and Control Plane. PostgreSQL
  and Kafka stayed up. The 108-character visible prefix was restored exactly;
  the old Run had one Attempt, failed/sealed/released, and projection passed its
  seal. Recovery took 17.5s with expected SSE reconnects. A follow-up accepted
  **before** the crash stayed waiting, then completed only after that seal. No old
  model/Tool Run was automatically replayed. This is process loss, not power loss.

Across all cohorts/retests: **68 Runs — 65 completed, one intentional cancellation,
one intentional crash failure and the discovered cancellation failure**. The 65
completed outcomes include the failed-Tool deployment probe described above.
Native assistant usage recorded 95,559 input, 464,128 cache-read and 2,954 output
tokens; these are reported usage fields, not billing reconciliation. No fresh
long-context/Compaction, provider-switch, whole-UI or multi-node acceptance is
claimed in this slice.

## Cleanup

Before cleanup, every owned Attempt was released/sealed and PG projection was
beyond its seal; no owner lease or unsealed family count remained. All five test
Workspaces were deleted through the API and their byte-purge markers confirmed;
both Tool runtime bindings were released. Scoped database cleanup removed five
test tenants, nine Session views (including two child Lanes), their history and
five Workspaces; original **33 tenants, 35 users, one Session and one Workspace**
remain. Private test credentials, scripts and raw reports were removed after
recording these aggregate results. Owned temporary PostgreSQL containers and
databases were removed. Final production health checks pass, with zero active
Runs, Session leases or unsealed family counts. Shared Kafka/WAL and formal service
logs keep their normal retention policy; no shared topic or user data is reset.
