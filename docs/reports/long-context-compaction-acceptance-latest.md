# Long-context Pi compaction production acceptance

- Checked at: 2026-09-10T13:54:38.911Z
- Revision: `260e1fba3f954e5dd86d8793ee01b02665feb102`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before 2 completed Compactions: 15
- Native Pi Compactions observed: 2
- Compaction reason/tokens: threshold, 111696 -> 24179
- Compaction duration: 20530 ms
- Triggering Run first-response/settled: 15005 / 151236 ms
- Post-compaction recall first-response/settled: 1746 / 1958 ms
- Post-compaction coding first-response/settled: 2387 / 116755 ms
- Cross-Worker recovery: pi-cloud-worker-2 -> pi-cloud-worker-1
- Same bounded-warm Cube runtime rebound: true
- Post-compaction Provider/Worker switch: pi-cloud-worker-1 -> pi-cloud-worker-2, openai-codex/gpt-5.6-luna, Fast=true
- Post-compaction Hosted Web Search first-response/settled: 8067 / 19397 ms
- Pi-native assistant usage records: 187 (excludes unrecorded retry and Compaction usage)
- Real input/output/cache-read/cache-write tokens: 259895 / 208898 / 11059968 / 0
- Final Pi SessionStorage bytes/entries: 967209 / 431
- Final active context bytes/entries: 314738 / 127

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a bounded-warm CubeSandbox KVM over a persistent Workspace Volume. Pi completed two native threshold/overflow Compactions, retained an early conversation invariant, continued coding afterward, restored the compacted native Session on a different Worker, then switched the Session to GPT Fast on another Worker and completed Provider-hosted Web Search without a Pi Tool call.
