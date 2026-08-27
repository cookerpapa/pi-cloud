# Kafka broker restart acceptance

- Checked at: 2026-08-27T11:32:43.336Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 226
- SSE reconnects: 2
- Run Attempts: 1
- Elapsed: 24950 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
