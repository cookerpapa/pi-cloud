# Control Plane restart acceptance

- Checked at: 2026-08-23T03:07:55.215Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 71
- SSE reconnects: 32
- Run Attempts: 1
- Elapsed: 59939 ms

The Control Plane container received SIGKILL after the first Accepted-Kafka assistant delta. The trusted Worker continued the fenced Run while Kafka retained the hot stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt only its bounded recent replay window, SSE reconnected, and the Run completed with one Attempt.
