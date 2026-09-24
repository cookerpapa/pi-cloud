# Control Plane restart acceptance

- Checked at: 2026-09-24T13:43:02.154Z
- Provider/model: openai-codex / gpt-5.6-luna
- First visible / terminal sequence: 3 / 762
- SSE reconnects: 22
- Same Run and Worker retained: true
- Elapsed: 47599 ms

The Control Plane received SIGKILL after the first Kafka-acknowledged assistant delta. The Worker continued its Run. The replacement Projector rebuilt the snapshot, SSE reconnected, and the same Run/Worker reached completion.
