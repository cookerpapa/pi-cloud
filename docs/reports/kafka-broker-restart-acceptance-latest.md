# Kafka broker restart acceptance

- Checked at: 2026-08-26T15:48:15.727Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 187
- SSE reconnects: 2
- Run Attempts: 1
- Elapsed: 23895 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
