# Long-context Pi compaction production acceptance

- Checked at: 2026-08-27T11:19:47.293Z
- Revision: `d7f5a523e4568b646dd137076a7a54e603ef2531`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before 2 completed Compactions: 11
- Native Pi Compactions observed: 2
- Compaction reason/tokens: threshold, 114647 -> 23712
- Compaction duration: 26466 ms
- Triggering Run first-response/settled: 2449 / 358303 ms
- Post-compaction recall first-response/settled: 2239 / 2788 ms
- Post-compaction coding first-response/settled: 2439 / 80918 ms
- Cross-Worker recovery: pi-cloud-worker-1 -> pi-cloud-worker-2
- Same bounded-warm Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 240 / 238 / 2
- Real input/output/cache-read/cache-write tokens: 333576 / 204919 / 14907648 / 0
- Final Pi SessionStorage bytes/entries: 877476 / 490
- Final active context bytes/entries: 243071 / 124

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a bounded-warm CubeSandbox KVM over a persistent Workspace Volume. Pi completed two native threshold/overflow Compactions, retained an early conversation invariant, continued coding afterward, and restored the compacted native Session on a different Worker while rebinding the same warm Cube runtime.
