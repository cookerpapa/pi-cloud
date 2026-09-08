# Tool result delivery and retirement

2026-09-08; candidate based on `a7b658cf`, working tree modified.
[Decision](../adr/0157-kafka-driven-tool-commands.md).

## Contract

The Worker associates every concrete read/write/edit/bash operation with its
native Tool call ID, outside the guest request and model context. Broker correlates
the exact accepted execution scope and call. The Harness already publishes the
native Tool Result and its PiCloud completion event in one Kafka Fact; consuming
that completion retires raw response copies. Broker does not parse Pi internals,
query PostgreSQL for this acknowledgement or add an ACK message/topic.

Broker's execution map now retains only running operations. The command consumer
is the sole completed-body cache. It keeps lightweight ID/hash tombstones after
retirement, so redelivery cannot restart an effect. A late GET receives an explicit
unavailable outcome. In-flight readers retain their own references. Seals retire
missing-result calls; already-admitted effects may finish but cannot repopulate
retired bodies. A 64 MiB default encoded retry-body budget sheds oldest copies on
overflow, not execution history. It is not a cap on process heap or HTTP buffers.

## Deterministic verification

`npm run check`: type checks and 696 tests passed; three existing environment-gated
tests skipped. Targeted tests cover one Tool/multiple operations, exact execution
scope, duplicate receipts/commands, ID reuse with changed arguments, seal/other-Lane
isolation, UNKNOWN acknowledgement before completion, cache overflow, and 500
consecutive Tool acknowledgements without waiting for Run termination. The existing
Broker tests verify that a completed direct internal repeat reaches the durable
no-replay ledger instead of returning another retained body.

Native edit tests verify that both the read and write carry the same Tool call ID.
Gate tests verify preservation of that ID without passing its lease to Kafka.
Build, formatting, documentation, Helm/distributed-value validation, installer,
runtime time budgets, image closure and security audit passed. The Web build retains
its existing large-chunk advisory; this change does not alter the UI bundle.

## Real Kafka / HTTP / process fault

Run `PI_CLOUD_LIVE_TOOL_COMMAND_CHECK=1 node scripts/run-kafka-tool-command-check.mjs`.
The private R=3, four-partition topic uses two real consumers and production result
HTTP servers with a counting executor, in a 3 CPU / 2 GiB container.

- 3,759 counting effects; zero duplicate effects.
- One unsealed Run performed 250 Tools with 96 KiB raw output each. After every
  native result acknowledgement its retained body bytes returned to zero.
- Both consumers finished with zero completed-result bodies/bytes. Their peak
  encoded retained-body measurements were 160,454 and 160,768 bytes, excluding
  operation metadata and transient serialization/transport memory.
- Duplicate command after result retirement did not execute again; late GET
  returned unavailable. Long Tool execution did not block another Session.
- Post-seal command did not execute. SIGKILL/replacement of a consumer process
  did not replay the old binding's effect. This does not claim Cube-native
  atomic process fencing.

The 1/16/128/1,024-Session bursts are correctness/load probes on a shared host.
Aggregate throughput now includes native receipt publication; command latency
ends at HTTP response. They must not be compared as a speedup/regression against
the previous command-only workload. The largest burst measured 980.1 commands/s
and p50/p95 28.14/2,633.69 ms; it is not 1,024 real coding VMs or a Kafka limit.
[Measured evidence](tool-result-retirement-acceptance-latest.json).

## Real DeepSeek / browser / Cube

Run `PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK=1 node --import tsx scripts/run-live-tool-preparation-check.mjs`.
The deployed Worker/Gate/Broker were updated together after confirming zero active
Runs and zero uncommitted seals. Cube guest/template protocols were unchanged.

The browser/API created a disposable elastic Workspace and conversation. Round one
wrote insertion/merge sort, binary search and tests; round two read/edited the file
to add heap sort and more tests. Chrome verified write/edit activity and refresh
recovery. Final native Bash results contain `OK` for 14 and 25 tests respectively.
The model initially wrote an invalid binary-search test on descending input, then
corrected it and reran the suite. Its `python ... | tail` pipeline explains why the
initial test-failure text had shell exit zero; no result was fabricated by Broker.

| Round | Total including model | Raw operations acknowledged by native Kafka result | Retained bytes afterward |
| --- | ---: | ---: | ---: |
| write + execute + correction | 24.350 s | 5 | 0 |
| read + edit + execute | 13.351 s | 4 | 0 |

PostgreSQL contains nine succeeded Broker operations. Broker's release counter
records nine `native_result` retirements, not seal/binding cleanup. Fresh Worker
metrics record Pi usage input 4,642, output 4,139 and cache-read 86,272 tokens.
[Browser and cache evidence](tool-preparation-acceptance-latest.json).

An initial test setup omitted the protected metrics endpoint's bearer header and
stopped before a model Run; the probe was corrected to read the mounted metrics
credential internally, without printing it or weakening endpoint authentication.

## Cleanup

The API deleted both disposable conversations/Workspaces; the Volume reaper
confirmed byte deletion. Their two temporary accounts/tenants were removed after
verifying no active Run or unpurged Workspace. Existing users/resources remain.
Private Kafka topics and subprocesses were removed, Chrome temporary profiles
were deleted. Shared production Kafka/container logs retain normal retention;
they were not reset or purged across other users. Only redacted acceptance
reports are kept in Git.
