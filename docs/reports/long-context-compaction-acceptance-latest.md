# Long-context Pi compaction production acceptance

- Checked at: 2026-09-14T06:54:52.147Z
- Revision: `c9a3b333fa2a955cc28b87dbee5c6dd02f629cf8`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before 2 completed Compactions: 12
- Native Pi Compactions observed: 2
- Compaction reason/tokens: threshold, 113937 -> 24353
- Compaction duration: 18664 ms
- Triggering Run first-response/settled: 12939 / 127419 ms
- Post-compaction recall first-response/settled: 1268 / 1408 ms
- Post-compaction coding first-response/settled: 1460 / 62815 ms
- Cross-Worker recovery: pi-cloud-worker-2 -> pi-cloud-worker-1
- Same bounded-warm Cube runtime rebound: true
- Post-compaction Provider/Worker switch: pi-cloud-worker-1 -> pi-cloud-worker-2, openai-codex/gpt-5.6-luna, Fast=true
- Post-compaction Hosted Web Search first-response/settled: 7251 / 12552 ms
- Pi-native assistant usage records: 147 (excludes unrecorded retry and Compaction usage)
- Real input/output/cache-read/cache-write tokens: 285216 / 202617 / 8060416 / 0
- Final Pi SessionStorage bytes/entries: 819486 / 325
- Final active context bytes/entries: 201029 / 77

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a bounded-warm CubeSandbox KVM over a persistent Workspace Volume. Pi completed two native threshold/overflow Compactions, retained an early conversation invariant, continued coding afterward, restored the compacted native Session on a different Worker, then switched the Session to GPT Fast on another Worker and completed Provider-hosted Web Search without a Pi Tool call.
