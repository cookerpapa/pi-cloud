# CubeSandbox production acceptance

- Checked at: 2026-09-09T05:34:00.789Z
- Provider/model: openai-codex / gpt-5.6-terra
- Pure-chat first activity / assistant text / settled: 3132 / 3132 / 3591 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 22 / 261 / 3074 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 12288 / 12288 / 22848 / 24018 ms
- Follow-up first activity / Tool / assistant text / settled: 4744 / 4744 / 22541 / 23685 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 38 / 272 / 20874 / 1334 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 17 / 258 / 21025 / 724 ms
- Coding Tool calls: 2 + 3
- Same running Workspace Cube KVM guest reused: true
- Agent Preview / background process survived cross-Run Tool bindings: true / true
- Elastic runtime / conversation deletion preserved Workspace ownership: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files / Volume reference: 1025 / 869 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 42274 / 2337 / 159488
- Canonical conversation: 5 terminal Turns / 38 Pi entries / 43510 bytes
- Current Kafka topic / end-offset sum / published seals: pi-cloud.execution-log.v7 / 2147 / 5
- PostgreSQL hot-event table absent / projected Session mutations: true / 68
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the conversation did not implicitly own or destroy that Workspace runtime, and explicit eviction removed it. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
