# Pi Durable 1.0 boundary verification

An isolated evaluation under ADR-0228. This directory is deliberately outside
the application workspaces. At the evaluation revision production Pi was 0.84.1;
ADR-0229 subsequently migrated production to 1.0.0. These historical evaluation
commands are not the current runtime or deployment procedure. No executable user
code runs on the trusted host. Deterministic tools model remote effects; the
explicit live check runs its shell only in a disposable Cube VM.

From a clean checkout after the repository's normal `npm ci`:

```sh
cd scripts/experiments/pi-durable
npm ci --ignore-scripts --workspaces=false
node --import tsx conformance.mjs /tmp/durable-conformance.json
node --import tsx run.mjs
node --import tsx policy-probes.mjs /tmp/durable-output.json
```

`run.mjs` creates disposable PG and three Kafka containers using the existing
pinned fixture helpers. It reuses the production ingress, transactional writer
and ordered consumer in one private group. Fixture scopes replace PG admission;
the private batch envelope is not a production API/schema. The PostgreSQL table
is a probe journal, not a proposed additional Tool-operation ledger. Cold reopen
replays this small journal; it is explicitly not the required bounded production
bootstrap. The public upstream `MemoryStorage.prepareCommit()` owns validation,
detachment and in-memory queries. Kafka confirmation precedes `apply()`.

The default report path is `docs/reports/pi-durable-verification-20261005.json`;
override it with `PI_CLOUD_DURABLE_PROBE_REPORT`. `compatible: false` is a measured
semantic mismatch, not a passing production acceptance assertion. Unexpected
failures make the command fail. Three recovery cases SIGKILL only an owned child
Node process; the external effect counter lives in its surviving parent.

With the maintained self-hosted K3s runtime and its built application image:

```sh
PI_CLOUD_DURABLE_LIVE_CUBE=1 node --import tsx run-live.mjs
```

This uses one temporary trusted test container (existing image by digest),
read-only repository access, a disposable PG, private Kafka topics and one
owned Cube allocation. Container-local host aliases resolve Kafka's advertised
Service names. It neither deploys Pi 1.0 nor changes host/cluster DNS. The model
is scripted so exact operation/result/cancellation behavior is deterministic.
Override `PI_CLOUD_DURABLE_PROBE_IMAGE` for a different locally built matched
application image. At that evaluation revision the guest used the then-deployed protocol and old fixed
Tool package: the test proves interoperability through PiCloud's existing reply
schema, not upgraded built-in Tool parity.

Credentials remain in trusted fixture processes and are not copied into the VM
or evidence. Cleanup closes the exact allocation, confirms recorded-node
absence, retires the owned reply topic and removes fixture PG/Kafka resources.
No shared service fault injection or application data reset is performed.

At the evaluation date adoption still needed a chosen Session/task schema, indexed PG projection,
bounded cold restore, immutable image codec, PG lease and Run reconciliation,
product queue policy and a cancellation design that retains confirmed results.
These scripts are evidence for that decision, not a dormant alternate runtime.
