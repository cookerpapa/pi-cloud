# Long-context Pi compaction production acceptance

- Checked at: 2026-09-16T23:17:24.220Z
- Revision: `e228f00cb563acbcc8c12d59e8f94f05f26bfd15`
- Provider/model: deepseek / deepseek-v4-pro
- Coding Turns before 2 completed Compactions: 13
- Native Pi Compactions: 2 during coding; 4 across the full Session/Lane log
- Independent Web Terminal check: `python3 -m unittest discover -s tests -q`, 370 tests, exit 0
- Compaction reason/tokens: threshold, 111682 -> 22615
- Compaction duration: 19025 ms
- Triggering Run first-response/settled: 1483 / 268735 ms
- Post-compaction recall first-response/settled: 5128 / 5261 ms
- Post-compaction coding first-response/settled: 1513 / 90488 ms
- Cross-Worker recovery: pi-cloud-pi-worker-local-v1-1 -> pi-cloud-pi-worker-local-v1-0
- Same bounded-warm Cube runtime rebound: true
- Post-compaction Provider/Worker switch: pi-cloud-pi-worker-local-v1-0 -> pi-cloud-pi-worker-local-v1-1, openai-codex/gpt-5.6-luna, Fast=true
- Post-compaction Hosted Web Search first-response/settled: 6362 / 14438 ms
- Pi-native assistant usage records: 257 (excludes unrecorded retry and Compaction usage)
- Real input/output/cache-read/cache-write tokens: 538030 / 183727 / 16135296 / 0
- Final Pi SessionStorage bytes/entries: 899105 / 539
- Final active context bytes/entries: 272352 / 150

The workload used real multi-round Python coding tasks, remote Tool calls and a
bounded-warm CubeSandbox KVM over a persistent Workspace Volume. Two coding
Compactions preserved the early invariant; subsequent coding moved to another
Worker. GPT medium/Fast search and the switch back to Pro high/no-Fast searched
successfully. The parent and an inherited child subsequently compacted again;
both inherited/fresh children completed with their saved settings and expected
context boundaries. This exercises the repaired hosted-search/Compaction path.

A separate authenticated terminal ran the complete generated test suite after
cross-Worker coding, not merely trusting the model's final answer. All 370 tests
passed. Both Worker replicas were restored; API resources and the persistent
Volume were removed, and temporary credentials were revoked.
