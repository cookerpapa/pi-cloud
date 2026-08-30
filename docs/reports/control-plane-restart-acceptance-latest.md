# Control Plane restart acceptance

- Checked at: 2026-08-30T16:55:24.424Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 201
- SSE reconnects: 12
- Run Attempts: 1
- Elapsed: 18648 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
