# Terminal wake and settlement SQL acceptance — September 18, 2026

**Retain the change.** Matched real-Luna comparisons reduced warm settlement
tail median **95.095 → 60.530ms**, and whole-Turn non-provider median
**198.924 → 150.765ms**. These are small one-host cohorts, not latency SLOs or
evidence that storage tails disappeared.

## Implementation

Runtime candidate `4fbc4144`; SQL-count assertions `642bbbff`; final direct-PG
configuration/Helm wiring `c5cbb98d`. See [ADR-0177](../adr/0177-terminal-wake-and-local-sql.md).

- The seal INSERT and an empty `pg_notify` share one SQL statement and commit.
  Each Projector relay has one dedicated LISTEN connection, bounded reconnect,
  and post-LISTEN rescan. The Worker queue's generation-based wake primitive is
  shared rather than copied. The existing 50ms scan and publication backoff
  remain; hints cannot bypass backoff, claim CAS or per-Session head ordering.
- Completion's already-locked Turn and Session updates share one SQL round trip
  with exact row-count checks. Scope release reuses lease identity protected by
  KEY SHARE and the physical-Session lock, eliminating the nested helper's
  repeated lease read. Peer-Lane and Worker capacity checks are unchanged.
  Tests verify one combined completion statement and one full lease read in the
  completion suffix, including rollback. **Two ordinary SQL round trips were
  removed, not two commits.**
- Input, admission, started/running, output-drain, completion and seal-projection
  durability boundaries remain separate. No PG migration, per-Session listener,
  new middleware, weaker ACK/fsync or per-Step projection receipt was introduced.

Helm now mounts the existing direct notification Secret for Control Plane, as
it already does for Worker. Both use `DATABASE_NOTIFICATION_URL_FILE`; absent
that setting, direct-PG Compose uses its ordinary database URL. Explicit invalid
or conflicting notification settings fail validation rather than being ignored.
One replica adds one listener connection, not one connection per active Run.
SQL pooling and session-scoped LISTEN are documented separately. Configuration
and rendered Helm contracts were tested; this was not a live PgBouncer deployment.

## Matched real model comparison

Old/new/old/new cohorts restarted CP and Worker from saved immutable images.
Baseline CP `5c9977fa`, Worker `aad78995`; candidate both `4fbc4144`. CP limits
stayed 1.5 CPU/768MiB, Worker 2 CPU/2GiB with four family/model slots and four PG
pool connections. Same PostgreSQL, RF3/acks-all Kafka, provider route, Luna medium,
Standard service, host settings and prompts. No builds, test suites or profilers
ran during the timed cohorts.

Each cohort created one tenant/Session and completed 15 sequential short replies
over one persistent SSE connection. Three initial Turns warmed each restarted
process; all 60 replies passed, with no unexpected SSE reconnect. The following
statistics use the remaining **12 Turns per cohort**, 24 per version.

| Cohort | Submission → provider dispatch median | Provider end → terminal receipt median | Whole-Turn non-provider median |
| --- | ---: | ---: | ---: |
| Old 1 | 100.836ms | 105.208ms | 209.112ms |
| New 1 | 91.831ms | 61.649ms | 154.017ms |
| Old 2 | 96.878ms | 92.852ms | 196.726ms |
| New 2 | 87.874ms | 58.180ms | 143.274ms |

| Pooled metric | Old median / p95 | New median / p95 |
| --- | ---: | ---: |
| Startup | 98.397 / 185.373ms | 89.454 / 133.637ms |
| Settlement tail | 95.095 / 181.390ms | 60.530 / 86.316ms |
| Entire Turn excluding provider route | 198.924 / 385.815ms | 150.765 / 221.008ms |

Medians average the middle pair; p95 uses nearest rank. Whole-Turn samples are
calculated individually, not by adding independent medians. Provider-route time
includes CLIProxyAPI. SSE client receipt is not browser paint. The warm tail
median improved about **36%**, whole-Turn non-provider median about **24%**.
Startup was not the primary target: its smaller observed change cannot be
confidently attributed to these settlement changes.

No outlier was dropped within the measured groups. The candidate still had a
158.696ms measured settlement tail and a 364.408ms startup during warm-up. Host
WAL stalls and shared-row wait propagation remain. This combined comparison does
not isolate each patch's individual contribution; the
[prior notification-only study](flow-critical-path-research-20260918.md) separately
measured that mechanism with a simulated bus.

## Correctness and final deployment

Related suites passed **337 unique tests** (336 in the sweep, plus the corrected
concurrent-settlement barrier rerun); one existing opt-in Kafka topic-policy check
was not enabled. That test barrier initially matched only a bare INSERT and
missed the new INSERT-containing CTE. It now identifies the same Outbox effect;
the real-PG two-settlement/no-lock-upgrade assertion passed. An initial run-queue
attempt used the known-limited PGlite socket path; all 11 passed with the actual
PG environment used by CI. These failed attempts were not counted as passes.

The 23 actual-PG admission tests include new commit/rollback notification,
hint-during-empty-scan, terminated listener/periodic delivery, reconnect and
shutdown cases. Later SQL-count assertions reran both commit/rollback cases.
Shared-family release and expiry tests passed. All workspace typechecks,
formatting and documentation checks passed. **26/26 maintained fault gates**
passed at clean `642bbbff`; these are controlled fixtures, not another full
production chaos exercise. Final configuration wiring passed seven targeted
config/startup tests and Helm render/contracts.

On the deployed candidate, two waves ran **four tenants/four overlapping Runs**;
PG claim/settlement timestamps confirmed overlap four and replies stayed attributed.
Two real Cube coding Turns wrote/tested insertion sort and binary search; product
file APIs confirmed the first file stayed byte-for-byte unchanged in the second
Turn. All five Tool results were non-error, with two Bash PASS results. A real
user cancellation produced a cancelled terminal, followed by a successful new
message in the same Session.

After the direct-URL wiring change, final CP `c5cbb98d` and Worker `4fbc4144`
were deployed and two more real Luna smoke Turns passed. They were cold samples,
excluded from the comparison (startup 174.516/120.559ms, tail 109.527/79.212ms).
The final CP has one notification listener. Total live work: **74 Runs, 73
completed and one intentionally cancelled**; native usage **102,053 input,
426,240 cache-read and 1,975 output tokens**. These are recorded usage fields,
not billing reconciliation. No fresh Compaction stress or full UI audit is claimed.

## Cleanup

All test Attempts were sealed, released and projected beyond their seal offsets
before cleanup. Five test accounts/Session Workspaces, their scoped history,
and the one Cube runtime/Volume were removed through resource deletion followed
by scoped DB cleanup. Original 33 tenants, 35 users and one Session/Workspace
remain. Both isolated PostgreSQL test containers/databases were removed.
Baseline comparison image tags, private test credentials/scripts and raw traces
were deleted after writing this report; versions can be rebuilt from Git.
Shared Kafka/WAL/formal service logs retain their normal policy. New production
images remain active. The unapproved drain/completion merge was not implemented.
