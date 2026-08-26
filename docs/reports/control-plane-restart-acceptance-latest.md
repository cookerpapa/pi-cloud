# Control Plane restart acceptance

- Checked at: 2026-08-26T15:20:17.223Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 188
- SSE reconnects: 10
- Run Attempts: 1
- Elapsed: 18685 ms

The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.
