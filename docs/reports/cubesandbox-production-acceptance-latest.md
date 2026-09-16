# CubeSandbox production acceptance

- Checked at: 2026-09-16T14:05:21.140Z
- Provider/model: openai-codex / gpt-5.6-terra
- Pure-chat first activity / assistant text / settled: 5624 / 5624 / 5979 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 150 / 159 / 5366 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 10524 / 10524 / 17654 / 18404 ms
- Follow-up first activity / Tool / assistant text / settled: 3685 / 3685 / 20215 / 21015 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 97 / 106 / 15236 / 2508 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 203 / 93 / 19523 / 660 ms
- Coding Tool calls: 2 + 3
- Same running Workspace Cube KVM guest reused: true
- Agent Preview / background process survived cross-Run Tool bindings: true / true
- Elastic runtime / conversation deletion preserved Workspace ownership: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files / Volume reference: 1025 / undefined bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 30602 / 2600 / 138496
- Canonical conversation: 5 terminal Turns / 42 Pi entries / 50871 bytes
- Current Kafka topic / end-offset sum / published seals: pi-cloud.execution-log.v8 / 24706 / 5
- PostgreSQL hot-event table absent / projected Session mutations: true / 76
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the conversation did not implicitly own or destroy that Workspace runtime, and explicit eviction removed it. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
