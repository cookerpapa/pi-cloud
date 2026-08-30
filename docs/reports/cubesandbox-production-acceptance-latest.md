# CubeSandbox production acceptance

- Checked at: 2026-08-30T08:32:46.700Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first activity / assistant text / settled: 1140 / 1140 / 1422 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 11 / 195 / 782 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 1021 / 4727 / 1021 / 9598 ms
- Follow-up first activity / Tool / assistant text / settled: 2276 / 2276 / 3412 / 8656 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 11 / 206 / 4332 / 2318 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 37 / 270 / 5603 / 1214 ms
- Coding Tool calls: 2 + 3
- Same running Workspace Cube KVM guest reused: true
- Agent Preview / background process survived cross-Run Tool bindings: true / true
- Elastic runtime / conversation deletion preserved Workspace ownership: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files / Volume reference: 1025 / 868 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 5324 / 3175 / 203648
- Canonical conversation: 5 terminal Turns / 44 Pi entries / 39119 bytes
- Kafka AcceptedFacts / canonical Session heads: 6531 / 37
- PostgreSQL hot-event table absent / projected Session mutations: true / 111
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the conversation did not implicitly own or destroy that Workspace runtime, and explicit eviction removed it. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
