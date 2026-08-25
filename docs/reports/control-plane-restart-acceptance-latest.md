# Control Plane restart acceptance

- Checked at: 2026-08-25T04:58:57.261Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 79
- SSE reconnects: 10
- Run Attempts: 1
- Elapsed: 13450 ms

The Control Plane container received SIGKILL after the first JetStream-acknowledged assistant delta. The trusted Worker continued the fenced Run while JetStream retained the hot stream and PostgreSQL retained canonical Pi state. The replacement Gateway replayed the bounded Session subject, SSE reconnected, and the Run completed with one Attempt.
