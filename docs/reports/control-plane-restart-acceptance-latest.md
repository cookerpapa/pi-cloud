# Control Plane restart acceptance

- Checked at: 2026-09-16T22:13:43.849Z
- Provider/model: openai-codex / gpt-5.6-luna
- First visible / terminal sequence: 3 / 963
- SSE reconnects: 24
- Run Attempts: 1
- Elapsed: 42867 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
