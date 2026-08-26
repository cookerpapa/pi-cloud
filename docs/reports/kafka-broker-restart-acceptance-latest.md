# Kafka broker restart acceptance

- Checked at: 2026-08-26T10:13:21.592Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 966
- SSE reconnects: 2
- Run Attempts: 1
- Elapsed: 28770 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
