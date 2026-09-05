# Control Plane restart acceptance

- Checked at: 2026-09-05T01:23:04.527Z
- Provider/model: openai-codex / gpt-5.6-terra
- First visible / terminal sequence: 3 / 315
- SSE reconnects: 20
- Run Attempts: 1
- Elapsed: 20495 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
