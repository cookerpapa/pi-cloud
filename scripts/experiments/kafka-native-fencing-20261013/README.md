# Native Kafka fencing research

Research only; ADR-0209 remains the production architecture. This experiment does
not enable a direct-Worker transport, change a production dependency, or deploy.

From the repository root, with installed dependencies and Docker available:

```sh
node scripts/experiments/kafka-native-fencing-20261013/run.mjs /tmp/pi-cloud-native-fencing.json
```

The driver deliberately ignores existing PG/Kafka integration endpoint overrides.
It starts its own pinned three-broker RF3/minISR2 Kafka fixture and PostgreSQL
container, creates synthetic topics and a `research_grants` experiment table,
then removes the fixtures. It never opens PiCloud's business database. There are
no model calls, guest commands, production faults, or real Session messages.

Six asserted schedules cover:

1. A replacement with the same transactional ID fences an initialized predecessor;
   a second Session's producer remains usable.
2. Including the lease epoch in the transactional ID prevents mutual fencing.
3. PG validation **before** delayed initialization permits an obsolete PG grant
   to displace the current producer and publish visible stale data.
4. Fresh PG validation **after** initialization prevents stale data in that
   schedule, but the current producer has already been fenced and needs reopening.
5. The post-initialization check rejects a closed grant with no successor yet.
6. Closing PG admission, then taking over the transactional ID and writing the
   seal, fences a predecessor that passed its post-initialization check earlier.

These are deterministic interleavings of actual public client calls and PG
statements. The six primitive probes do not use SIGSTOP and do not implement the
production Run/lease/Outbox recovery protocol. A successful negative probe means
the intentionally incomplete candidate's failure was reproduced, not that a
production failure was injected.

Fresh Node child processes measure the RSS, OS thread and descriptor deltas of
1, 8 and 32 initialized/warmed producers. Each producer makes three small sequential
transactions; the latency samples are not an ingress-versus-direct A/B benchmark
or a capacity SLO. Producers live only for the probe, not for cold Sessions.

The driver also runs the maintained `publication.integration.test.ts` against its
private Kafka cluster: committed/aborted tails and the actual ingress publisher's
SIGSTOP/replacement/SIGCONT test. That regression proves its named schedules,
not every delayed-initialization or rolling-update interleaving.

See the [research report](../../../docs/reports/kafka-native-fencing-20261013.md)
for findings, source references, measurements and limits.
