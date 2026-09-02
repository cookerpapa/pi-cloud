# Kafka broker restart acceptance

- Checked at: 2026-09-02T05:08:58.339Z
- Provider/model: openai-codex / gpt-5.6-terra
- First visible / terminal sequence: 3 / 249
- SSE reconnects: 2
- Run Attempts: 1
- Elapsed: 28735 ms

One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt.
