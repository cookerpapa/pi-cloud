# Startup preparation optimization — September 17, 2026

Implemented and deployed application revision `31cdad6e`; baseline application
`6e92e850`, source baseline `615e8329`. One Compose Worker, four family/model
slots, PostgreSQL four-CPU limit, unchanged Kafka/Cube topology. No schema
migration, authority relaxation or new service. See [ADR-0173](../adr/0173-startup-context-reuse.md).

## Changes and boundaries

- Keep up to two already-created PG connections warm within each existing pool
  maximum. Excess idle/broken connections still retire. No per-Session connection.
- Select/lock one candidate and load its context without repeating queue
  eligibility. Explicit-ID dispatch uses the same checks. Physical-Session
  ownership still receives its post-lock verification.
- Carry immutable Session kind/Workspace seed kind from claim to the Runner.
  Remove the redundant PG seed resolver and root Tool metadata read. Resource
  identity/deletion checks remain in claim; live Tool authority is unchanged.
- Combine each lifecycle transition's Run, Attempt and transition-record writes
  into one SQL round trip. Keep separate started/running transactions: preparation
  can fail between them. Add `durable_running` stage timing.

The first candidate-query experiment regressed under warm load because the
adapter only named SELECT statements, not WITH statements. Bounded prepared
statement support now includes WITH, including transactional CTE writes; binding,
rollback, cancellation and connection-loss tests cover it. No global generic-plan
override was introduced. PostgreSQL defines these mechanisms in its
[CTE](https://www.postgresql.org/docs/current/queries-with.html) and
[PREPARE](https://www.postgresql.org/docs/current/sql-prepare.html) contracts.

## Measurements

All paid calls used GPT-5.6 Sol, medium, Standard. Values below are milliseconds
from API submission to local Model Gateway upstream dispatch, **excluding model
generation**. SSE values are client receipt, not browser paint. Builds and test
suites were stopped during paid measurement. Small cohorts are not capacity/SLO
proof or a randomized estimate of each change's individual contribution.

| Scenario | Before | After, first pass | After, complete rerun |
| --- | --- | --- | --- |
| First new Session | 184.7 | 294.0 | 367.5 |
| Three immediate follow-ups | 177.3 / 479.2 / 130.3 | 161.4 / 143.4 / 109.3 | 142.3 / 133.3 / 149.8 |
| Follow-up after 12 seconds idle | 151.3 | 100.4 | 107.4 |
| Another new Session | 137.3 | 131.5 | 152.4 |
| Four concurrent Runs, two tenants | 246.5–419.6 | 172.5–324.3 | 157.6–320.3 |
| Same Session after Worker restart | not tested | 226.8 | 262.6 |
| Two coding Turns | not tested | 216.7 / 175.5 | 190.4 / 190.5 |

Steady follow-up medians improved from 177.3 to 143.4/142.3ms; the idle-gap case
also improved. **First requests and tails are not uniformly faster.** The first
after-pass began on newly deployed processes; the complete rerun's 367.5ms sample
included 176.0ms in lease acquisition and 67.6ms opening the log. The baseline
479.2ms sample included 236.9ms in claim finish/commit. These observations do not
identify the underlying disk/lock/planning cause of every tail. Do not claim
all startup is below 150ms or attribute all improvement to the merged query.

On the complete rerun, first-text Pi event → SSE receipt was 7.1–13.2ms. The
first after-pass had one concurrent 27.1ms value. All client streams completed
without reconnect, with correct expected replies. PG claimed/settled timestamps
confirmed four genuinely overlapping Runs in every concurrent cohort.

An interleaved, model-free actual-ready-row benchmark on isolated PostgreSQL
used the same warm pool for both query implementations, 30 claims each. Median
claim was 24.9ms before / 24.2ms after: little steady-state difference once both
are cached. The isolated adapter regression test confirms a prepared connection
survives an 11-second idle gap; the [prior diagnosis](startup-latency-gpt-20260917.md)
documented the old adapter losing its plan and returning to a 42ms cold execution.

## Correctness and real usage

`npm run check`: 1,045 tests passed, three opt-in tests skipped (one Kafka topic
policy test, two standalone Cube provider security tests). Type checking and build
passed. [26 deterministic fault gates](fault-eval-latest.md) passed; they are not
live process-chaos evidence. The live tests below separately exercised the real
Kafka path, Cube coding and graceful Worker restart.
Formatting, dependency checks, installer contracts, Helm/preflight, runtime time
budgets, observability and image closure checks also passed. The high-severity
security gate passed; two existing moderate development-only Vitest advisories
remain, so this is not a claim of zero dependency findings.

Before: ten parent Runs. First after-pass: thirteen parent Runs completed; then
the helper incorrectly used absolute paths with the relative Workspace browser
API and received HTTP 400. No product workaround was added. Corrected helper
reran all fourteen parent Runs and two child Runs successfully. It checked:

- multi-round marker recall, including after Worker process replacement;
- two tenants/four concurrent Sessions with correctly attributed results;
- real insertion-sort and binary-search files, shell test execution over both
  rounds, successful Tool results, and file retrieval through the product API;
- branch and fresh-context child tasks, both completed in the parent's physical
  Pi Session, with inherited marker and independent arithmetic results returned.

Across all three cohorts: **39 Runs, 48 native assistant responses**, reporting
76,250 input, 244,736 cache-read and 1,784 output tokens. These are native usage
fields, not independently reconciled provider billing.

## Cleanup

Deleted six owned test Workspaces through product APIs; all six storage purge
markers completed. After verifying seals, PG progress and Kafka group delivery,
removed six test tenants, twenty conversation views and their thirty-nine Runs.
The original live Session, original accounts and model credentials remain.
No development machines were requested. The two test Cube runtimes were released
with their Workspaces. The isolated PostgreSQL test container/databases and private
probe files were removed. Shared Kafka/formal service logs retain normal retention;
they were not truncated to erase test records at the expense of real data.
