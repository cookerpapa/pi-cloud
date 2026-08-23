# Control Plane restart acceptance

- Checked at: 2026-08-23T19:28:05.184Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 88
- SSE reconnects: 30
- Run Attempts: 1
- Elapsed: 55755 ms

The Control Plane container received SIGKILL after the first Accepted-Kafka assistant delta. The trusted Worker continued the fenced Run while Kafka retained the hot stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt only its bounded recent replay window, SSE reconnected, and the Run completed with one Attempt.
