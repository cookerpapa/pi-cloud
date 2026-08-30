# Kafka broker restart acceptance

- Checked at: 2026-08-30T16:55:44.002Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 216
- SSE reconnects: 0
- Run Attempts: 1
- Elapsed: 14235 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
