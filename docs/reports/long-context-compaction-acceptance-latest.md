# Long-context Pi compaction production acceptance

- Checked at: 2026-08-25T09:45:39.791Z
- Revision: `f22e1344f5e30a0f275effb7827316a06fde2774`
- Provider/model: deepseek / deepseek-v4-flash
- Coding Turns before first completed compaction: 10
- Compaction reason/tokens: threshold, 115012 -> 23694
- Compaction duration: 18169 ms
- Triggering Run first-response/settled: 1799 / 134429 ms
- Post-compaction recall first-response/settled: 1069 / 1356 ms
- Post-compaction coding first-response/settled: 1921 / 137975 ms
- Cross-Worker recovery: pi-cloud-worker-1 -> pi-cloud-worker-2
- Same persistent Cube runtime rebound: true
- Real model attempts/completed/recovered failures: 170 / 168 / 2
- Real input/output/cache-read/cache-write tokens: 166776 / 115456 / 9279616 / 0
- Final Pi SessionStorage bytes/entries: 595103 / 370
- Final active context bytes/entries: 231861 / 121

The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a persistent CubeSandbox KVM. Pi completed native threshold/overflow compaction, retained an early conversation invariant, continued coding after compaction, and restored the compacted native Session on a different Worker while rebinding the same persistent Cube runtime.
