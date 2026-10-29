# Shared history roots: isolated validation

This is ADR-0286's executable PG history-directory experiment, **not a production
Storage adapter**. It cannot accept live PiCloud traffic and is not imported by
runtime packages or database migrations. All databases are randomly named,
synthetic and dropped by the fixture.

```sh
node scripts/run-with-test-postgres.mjs -- node scripts/experiments/shared-history-roots/run.mjs /private/history-roots --bench
```

Without `--bench`, the command runs the contracts only. Default measurements use
10/100/1024 MiB, 1,000 nested Forks and 120 ordinary-operation samples after warmup.
For a shorter development check:

```sh
PI_CLOUD_ROOT_BENCH_MIB=1,4 PI_CLOUD_ROOT_BENCH_NESTED=64 PI_CLOUD_ROOT_BENCH_SAMPLES=30 node scripts/run-with-test-postgres.mjs -- node scripts/experiments/shared-history-roots/run.mjs /private/history-roots-small --bench
```

Measure write amplification separately from latency instrumentation:

```sh
node scripts/run-with-test-postgres.mjs -- node scripts/experiments/shared-history-roots/wal-profile.mjs /private/history-roots-wal.json
```

[Measured results](../../../docs/reports/shared-history-root-prototype-20261029.md)
retain failed guardrails as well as successes. `completed: true` means the
experiment completed; `productionReady` remains false.

`schema.sql` creates the same tables/indexes for flat and directory-enabled modes.
Both validate identical batches, maintain commit identities, hash bodies and
presentation metadata, and perform the same append transaction shape. The
directory mode adds bounded prefix metadata. Timings alternate mode order and
exclude tracing overhead. SQL/byte traces are separate. First-context checks use
the pinned Pi Harness's public context API; its fixture-only runtime state is an
empty MemoryStorage and rejects all mutation.

The directory is an immutable AVL tree of stream prefixes. Ordinary append does
not copy tree paths; Fork/prune do. Prefix references have captured commit bounds,
read pins use actual FKs, and collection removes unreferenced suffix records and
assets. Assets are PG byte rows in this experiment, not a substitute S3 service.

## Interpretation limits

- Fork timing covers history-directory admission, not all product SQL, native
  document inheritance, Worker scheduling or LLM latency.
- Ordinary p95 ratios compare two modes of this experiment, not the entire
  deployed Projector. A ratio over 1.10 is reported as a failed initial performance
  guardrail, not rounded away or silently accepted.
- Inherited reads have their own direct-index controls. One-stream controls are
  mutation-disabled views over identical source rows while that source is held
  stationary. The small deep-Fork control is materialized outside all measured
  operations, with setup cost separately reported.
- The append stream currently requires monotonically increasing Entry IDs. The
  command proves that native MemoryStorage accepts reserved IDs committed out of
  order, while this prototype rejects them. This is an unresolved contract gap,
  not a claim of full upstream Storage conformance.
- Mutable document policies, child Conversations, Task/Submission/Inbox ownership,
  Kafka replay/rebuild, complete display migration and real S3 deletion are not
  implemented here. Production migration remains gated on those contracts.
- Context fixtures cover summaries, retained recent text, edits and Tool-result
  ordering; they do not run a live model or execute a Tool.
- PG/OS caches are not forcibly flushed. A fresh native reader is not a cold-disk
  benchmark. The GC stress interval is 10 ms, deliberately much more aggressive
  than the deployed maintenance interval.
- Fast Fork does not read every old body. Corruption of an old body is detected on
  access, while directory/boundary corruption rejects the operation immediately.

The fixture's generation and receipt checks are local experiment semantics. They
do not replace production Kafka fencing or prove cloud execution recovery.
