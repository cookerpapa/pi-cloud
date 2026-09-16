# Kafka broker restart acceptance

- Checked at: 2026-09-16T22:17:12.524Z
- Provider/model: openai-codex / gpt-5.6-luna
- First visible / terminal sequence: 3 / 1104
- SSE reconnects: 16
- Run Attempts: 1
- Elapsed: 48993 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
