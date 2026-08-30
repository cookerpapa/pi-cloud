# Long-context Pi compaction production acceptance

- Checked at: 2026-08-30T17:27:44.038Z
- Revision: `a1a41b0ab0940b38a1a7606a991b9ceebd317ff5`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before 2 completed Compactions: 11
- Native Pi Compactions observed: 2
- Compaction reason/tokens: threshold, 112373 -> 22920
- Compaction duration: 20566 ms
- Triggering Run first-response/settled: 1085 / 266823 ms
- Post-compaction recall first-response/settled: 1506 / 2005 ms
- Post-compaction coding first-response/settled: 1042 / 113657 ms
- Cross-Worker recovery: pi-cloud-worker-1 -> pi-cloud-worker-2
- Same bounded-warm Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 257 / 252 / 5
- Real input/output/cache-read/cache-write tokens: 301860 / 188660 / 15643008 / 0
- Final Pi SessionStorage bytes/entries: 902064 / 518
- Final active context bytes/entries: 225617 / 122

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a bounded-warm CubeSandbox KVM over a persistent Workspace Volume. Pi completed two native threshold/overflow Compactions, retained an early conversation invariant, continued coding afterward, and restored the compacted native Session on a different Worker while sharing the same warm Workspace runtime through a new Tool binding.
