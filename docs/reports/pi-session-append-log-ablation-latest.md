# Pi Session append-only log ablation

Date: 2026-09-04

Compared revisions:

- before: `d9483a90a1f0b8db4edc36917100394a4848219f` — identifier-only
  `pi_session_log` with Entry/Record JOIN hydration;
- after: `0889f4e8371fb68db17f9b953ade7f7aa3bf72b7` — self-contained
  semantic `pi_session_log` with direct replay.

## Method

The timed window contains no model request, model stream, Tool execution,
Kafka or Cube work. Both revisions received the same complete 1 KiB Pi semantic
Entry payloads and ran against fresh isolated containers using the same pinned
PostgreSQL image on the same WSL2 host. Before/after trials were alternated
three times; tables below report the median of those trials.

The existing real DeepSeek Subagent acceptance remains the functional workload
gate for Fresh/Branch Lanes, parallel/recursive Children and shared/isolated
Workspaces. Its Provider time is deliberately absent from this storage
ablation.

## Workload A: many active Sessions

2,000 Sessions × 4 complete events, 256 concurrent writers; 500 Session logs
then replayed concurrently.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| append throughput | 917.16 events/s | 903.31 events/s | -1.51% |
| append p50 | 261.04 ms | 265.45 ms | +1.69% |
| append p95 | 345.20 ms | 352.11 ms | +2.00% |
| append p99 | 485.58 ms | 503.48 ms | +3.69% |
| WAL per event | 6,566.80 B | 6,800.33 B | +3.56% |
| replay throughput | 22,769.20 events/s | 26,409.70 events/s | +15.99% |
| replay p50 | 39.29 ms | 35.11 ms | -10.64% |
| replay p95 | 48.95 ms | 42.99 ms | -12.18% |
| replay p99 | 53.09 ms | 46.97 ms | -11.53% |

## Workload B: longer Session histories

250 Sessions × 32 complete events, 128 concurrent writers; all 250 Session
logs then replayed concurrently.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| append throughput | 905.95 events/s | 865.98 events/s | -4.41% |
| append p50 | 122.25 ms | 127.43 ms | +4.24% |
| append p95 | 183.77 ms | 190.17 ms | +3.48% |
| append p99 | 343.45 ms | 322.02 ms | -6.24% |
| WAL per event | 6,512.18 B | 6,778.58 B | +4.09% |
| replay throughput | 57,798.29 events/s | 67,061.21 events/s | +16.03% |
| replay p50 | 65.79 ms | 57.43 ms | -12.71% |
| replay p95 | 82.39 ms | 72.46 ms | -12.05% |
| replay p99 | 107.69 ms | 94.37 ms | -12.37% |

## Conclusion

Making the log self-contained trades approximately 1.5–4.4% append throughput
and 3.6–4.1% WAL bytes for approximately 16% higher replay throughput and
10.6–12.7% lower replay latency. Normal conversation/context reads continue to
use transactional projections, so the replay improvement targets restore,
inspection and projection repair rather than every UI request.

All trials persisted the expected rows with zero failures. The new design is a
measured durability/read-path trade rather than a claim that append-only storage
makes every path faster.
