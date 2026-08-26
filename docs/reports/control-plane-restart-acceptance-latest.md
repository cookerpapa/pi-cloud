# Control Plane restart acceptance

- Checked at: 2026-08-26T09:40:55.665Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 734
- SSE reconnects: 16
- Run Attempts: 1
- Elapsed: 26812 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
