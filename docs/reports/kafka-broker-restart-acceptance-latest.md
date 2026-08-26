# Kafka broker restart acceptance

- Checked at: 2026-08-26T09:41:20.742Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 798
- SSE reconnects: 0
- Run Attempts: 1
- Elapsed: 24468 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
