# Control Plane restart acceptance

- Checked at: 2026-09-02T05:08:09.318Z
- Provider/model: openai-codex / gpt-5.6-terra
- First visible / terminal sequence: 3 / 353
- SSE reconnects: 18
- Run Attempts: 1
- Elapsed: 19501 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
