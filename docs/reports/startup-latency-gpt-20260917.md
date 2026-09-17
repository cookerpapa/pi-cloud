# GPT startup latency diagnosis — September 17, 2026

Diagnosis only: no production code, pool settings, durability guarantees or
service topology changed. Source HEAD `87f7ab03`; running application image
revision `6e92e850` (same application source). One Compose Worker, four family
slots/model permits; PostgreSQL limited to four CPUs. All components share this
WSL host. The previously corrected clock configuration remained unchanged.

## Real requests

Twelve paid `openai-codex/gpt-5.6-sol`, medium, Standard requests completed,
across four new Sessions in two disposable tenants. Each had one sampling request,
no Tools and no SSE reconnect. Follow-ups checked a remembered marker. Native
assistant usage total: 12,053 input, 66,048 cache-read and 76 output tokens.

The primary eight requests used before/after existing metric counters; each
window required exactly one successful Run claim and no other active Run at
entry. Four supplementary requests also sampled Worker PG connection IDs every
second. These small sequential cohorts are not a concurrency benchmark or SLO.

| Cohort | Submit → local Model Gateway upstream start, milliseconds |
| --- | --- |
| Primary: new Session, then five follow-ups | 282.7, 213.3, 197.4, 143.4, 193.5, 199.5 |
| Primary: two further new Sessions | 149.5, 232.7 |
| Connection observation: new Session, three follow-ups | 219.5, 178.4, 139.3, 214.4 |

Primary median: **198.5ms**, range **143.4–282.7ms**; supplementary median
196.4ms. Thus the earlier roughly 302ms figure is not a fixed per-request cost.
The primary model-route interval to first parsed text was 4.23–22.03 seconds;
it includes CLIProxyAPI/network/provider, not inference alone. Pi first-text
event → SSE client receipt was 7.9–12.8ms. This is **API/SSE receipt, not browser
paint or first reasoning token**. Sub-millisecond negative timestamp differences
between adjacent layers are clock resolution noise, not negative latency.

Primary stage observations:

| Stage | Median ms | Range ms |
| --- | ---: | ---: |
| Public API acceptance, client round trip | 24.6 | 16.9–32.5 |
| Successful claim transaction | 40.2 | 32.5–65.5 |
| Claim context query, included in claim above | 19.8 | 16.3–31.9 |
| Execution lease acquisition | 15.3 | 12.6–27.4 |
| Publication opening: PG transaction + Kafka ACK | 21.0 | 18.0–55.3 |
| Durable started/provisioning transition | 14.5 | 10.6–23.9 |
| Native Session open | 21.0 | 6.7–29.8 |
| Model runtime setup, parallel with Session open | 1.1 | 0.8–2.8 |

These are phase durations, **not additive slices**: claim subphases are nested,
API receipt can overlap scheduling, and model setup/Session open are parallel.
Queue-wait metrics already include part of admission/claim work. Idle unsuccessful
claim counters are not the foreground request's queue delay.

## Confirmed causes and remaining uncertainty

**Complex query planning is a measurable cost.** A Kysely interception captured
the actual production claim-context SELECT and aborted before executing it.
Separate diagnostic connections then ran it against an owned completed Run:
zero matching rows, no claim or mutation. Worker → PG `SELECT 1` round trip was
about 0.4ms. EXPLAIN showed ordinary custom planning around 18–20ms, execution
around 0.5–1.5ms, and no physical block reads. Initial cold planning was 38.6ms;
reused generic planning was 0.032–0.076ms. This establishes planning overhead,
not the execution/lock cost of a successful queued-row claim under load.

**Pool expiry can discard that optimization.** The existing database adapter
names prepared SELECTs but leaves `pg.Pool` idle lifetime at its 10-second
default. A controlled trial using that exact adapter measured twelve executions:
41.1ms cold, about 21ms for subsequent custom plans, then 1.1–1.8ms with reuse.
After 12 seconds idle the backend PID changed, cached-plan counters reset, and
the next execution took 42.5ms. Production observations also saw a newly created
Worker DB connection, but did not establish expiry as the cause of every slow Run.
Prepared plans belong to a database connection; PostgreSQL normally evaluates
five custom executions before considering a generic plan. These behaviors match
the [PG PREPARE contract](https://www.postgresql.org/docs/current/sql-prepare.html)
and [node-postgres pool defaults](https://node-postgres.com/apis/pool).

**Startup has several serial persistence phases.** Code inspection confirms
claim → lease → publication opening → started/provisioning → running transition,
before entering the Agent Loop. The last transition is another PG transaction
in `PostgresRunAttemptPhaseObserver`; existing metrics do not isolate its cost.
Workspace seed/trusted-tool metadata reads, initial native Kafka appends and local
model-request preparation also occupy the remaining interval. Do not label that
whole remainder as network, fsync or SQL: those costs were not individually traced.

No Worker model-permit pressure appeared (primary waits about 0.02–0.04ms),
nor PostgreSQL cgroup CPU throttling in the primary windows. Pure chat activated
no Cube. Small-context restoration and model setup do not explain a 300ms pause
on their own. No evidence here requires replacing Kafka or weakening ownership.

## Follow-up, not implemented

First benchmark connection/plan reuse and a simpler equivalent claim query with
real ready rows, idle gaps and concurrent Sessions. Preserve bounded pool size,
same-Lane ordering and ownership checks. Do not globally force generic plans:
different parameter distributions may need different execution plans.

Then instrument the unmeasured startup transitions and evaluate whether any can
share an existing transaction without changing lifecycle/recovery semantics.
The current evidence identifies avoidable work but does not prove a sub-100ms
target or an end-to-end improvement from any proposed setting.

## Cleanup

Normal APIs removed all four test conversation views and both Workspaces; both
storage-purge markers completed, and no VM was created. After verifying all
test seals, PG projection positions and Kafka group delivery, a scoped transaction
removed the two test tenants and their twelve Runs/native histories. The existing
real Session, original accounts and service configuration were preserved.
Shared Kafka and formal service logs were not truncated; their normal retention
continues. Private probes/raw measurement files were removed after this summary.
