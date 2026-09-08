# Kafka-driven Tool command acceptance

2026-09-08; candidate based on `907682e4`, working tree modified.
[ADR-0157](../adr/0157-kafka-driven-tool-commands.md).

## Implemented path

Pi Worker publishes a concrete remote operation on its existing Fact connection.
The PostgreSQL Authority Gate stamps canonical scope; Kafka acknowledges the
command; its owning Broker consumes it and invokes Cube. Worker then reads the
result through `GET /internal/v1/tool-operation-result` and gives it to Pi's
existing redaction/semantic-checkpoint path. Neither the removed execution POST
nor posting to the new result endpoint can trigger a command.

Pi's complete-model-output and validated-intent commits remain. Command PubAck
is an additional transport cost, not another Pi checkpoint. One native Tool may
use several remote operations. Raw result bodies are not stored in a second PG
transcript. Result waits hold no PostgreSQL transaction/connection. The existing
Broker operation ledger and Lease/owner admission checks remain; no Cube-level
atomic fencing guarantee was introduced.

The existing native Kafka consumer was extracted into `event-log`, a transport-
only package shared by the application and Broker. It does not import Pi or
SessionStorage. Broker uses boot-local progress/bindings, bounded active work,
operation-ID deduplication and no replay of vanished bindings. Separate Broker
consumer groups deliberately duplicate read traffic; there is no claim of
exclusive global partition routing. Brokers are trusted readers of the shared
log, while Workers/guests still have no Kafka access.

## Model-free transport measurement

Run `PI_CLOUD_LIVE_TOOL_COMMAND_CHECK=1 node scripts/run-kafka-tool-command-check.mjs`.
This uses a private R=3 Kafka topic with four partitions, two actual consumers,
the production HTTP result servers and a counting executor in a 3 CPU / 2 GiB
container. It measures accepted command → Kafka → Broker dispatch → result GET,
not Gate SQL, an LLM, or real Cube compute capacity.

| Concurrent Sessions | Commands | Commands/s | p50 / p95 |
| --- | ---: | ---: | ---: |
| 1 | 3 | 2.9 | 10.45 / 1,009.88 ms |
| 16 | 48 | 301.3 | 19.52 / 123.53 ms |
| 128 | 384 | 641.9 | 34.80 / 521.55 ms |
| 1,024 | 3,072 | 1,589.5 | 20.33 / 1,528.41 ms |

These short burst runs include cold producer/HTTP connection establishment;
the three-sample first row is not a steady-state capacity estimate. The measured
tail at the largest burst is still substantial and must not be advertised as
1,024 real coding sandboxes. Both consumers read the whole private log and only
executed owned bindings, explicitly demonstrating the replica read multiplier.

The same test verified no duplicate effects, long commands not blocking another
Session, post-seal command rejection and both execution POST routes returning
404. A subprocess was SIGKILLed after entering a held command but before the
counting effect; a new boot did not execute the old binding when its command was
redelivered, and did execute a new binding. This tests transport/boot behavior,
not physical Cube stale-process isolation.
[Raw evidence](kafka-tool-command-acceptance-latest.json).

## Real DeepSeek / browser / Cube

The deployed v5 path was exercised through the actual browser-facing API and
Chrome. Two coding rounds created insertion/merge sort and binary search, ran
tests, then read/edited the same file to add heap sort and reran tests. Final
Bash outputs were `OK` for 9 and 16 tests. Write/edit preparation was animated,
and refreshing during generation restored the same activity.
Round totals were 23.641 / 20.409 seconds, including model time.
[Initial evidence](https://github.com/cookerpapa/pi-cloud/blob/a7b658cf/docs/reports/tool-preparation-acceptance-latest.json).
The later [result-retirement acceptance](tool-result-retirement-acceptance.md)
uses the updated probe and latest browser report.

Read-only inspection matched all eight Kafka `tool_command` IDs to eight
succeeded Broker operation rows for that exact acceptance tenant:

| Operation | Command creation → Broker admission | Broker operation duration |
| --- | ---: | ---: |
| first file.write | 11 ms | 8,046 ms (cold materialization included) |
| bash.exec | 9 ms | 414 ms |
| file.read_range | 13 ms | 572 ms |
| file.read | 10 ms | 379 ms |
| file.write | 9 ms | 177 ms |
| file.read | 7 ms | 175 ms |
| file.write | 9 ms | 268 ms |
| bash.exec | 8 ms | 991 ms |

These timestamps use the same host clock; admission is the start of the Broker
ledger transaction, not a claim that the Cube process has already started.

Three tenants × two rounds completed 6/6 on both deployed Workers, restored
three markers, denied three cross-tenant reads, leaked no markers and used one
Attempt per Run. First text p50/p95 was 2.166 / 8.645 seconds, including queue
p95 7.697 seconds while coding shared the two local parent slots. Six model
requests used 508 uncached input, 800 output and 35,712 cache-read tokens.
[Evidence](https://github.com/cookerpapa/pi-cloud/blob/a7b658cf/docs/reports/multi-tenant-model-load-latest.json).

An additional owned-VM Snake task used 14 Tools and the structured Preview Tool.
After Run completion the host preview returned HTTP 200; real Chrome verified
start/movement, stable paused state and reset. The game remained available after
the execution seal. Total Run time 59.332 seconds; first visible text 1.002 seconds.
[Evidence](snake-preview-acceptance-latest.json).
An initial Snake attempt reached Run completion but its test still asserted the
old generic preparation label; the assertion was aligned with the current
write-specific UI text before rerunning the full game interaction.

## Verification and cleanup

The implementation includes command Gate identity/lease stripping, Frame ACK,
consumer reconnect floor, no-execution result reads, duplicate command and lost
binding tests. Final `npm run check` passed type checking and 691 tests with three
existing environment-gated skips. Build, installer, Helm, runtime budgets,
native-addon image closure, documentation, formatting and security audit passed.
Trace context now follows the command into actual Broker execution; result GET
metrics are separate so HTTP retries are not counted as repeated Tool effects.

Migration 130/topic v5 were deployed after draining Runs and Outbox. Six exact
acceptance tenants/accounts were purged only after their Workspaces/machines
were released and Volume deletion confirmed. Counts returned to 35 users,
52 Sessions and one live Workspace. Private Kafka test topics/groups and child
processes were removed; shared production Kafka keeps bounded test facts until
normal retention, without resetting user history. Cube templates/source were
not changed. Initial fixture failures were an omitted Kafka config variable,
an old UI-label assertion and treating auto-deleted Kafka groups as a cleanup
error; these were corrected before final acceptance.

Cube entry-point generation isolation is research only; see the
[versioned study](cube-execution-generation-study.md). Existing processes can
outlive a Broker connection, and no exactly-once Shell claim is made.
