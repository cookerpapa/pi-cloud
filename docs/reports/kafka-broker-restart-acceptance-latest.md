# Kafka broker restart acceptance

- Checked at: 2026-09-10T14:46:27.810Z
- Provider/model: openai-codex / gpt-5.6-terra
- First visible / terminal sequence: 3 / 219
- SSE reconnects: 0
- Run Attempts: 1
- Elapsed: 25999 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
