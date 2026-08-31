# CubeSandbox production acceptance

- Checked at: 2026-08-31T14:24:18.175Z
- Provider/model: openai-codex / gpt-5.6-terra
- Pure-chat first activity / assistant text / settled: 3071 / 3071 / 3552 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 23 / 283 / 2655 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 3421 / 3421 / 24403 / 25423 ms
- Follow-up first activity / Tool / assistant text / settled: 4173 / 4173 / 25518 / 26571 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 16 / 251 / 17097 / 4988 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 16 / 245 / 24008 / 1053 ms
- Coding Tool calls: 3 + 3
- Same running Workspace Cube KVM guest reused: true
- Agent Preview / background process survived cross-Run Tool bindings: true / true
- Elastic runtime / conversation deletion preserved Workspace ownership: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files / Volume reference: 1025 / 869 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 37914 / 2586 / 93696
- Canonical conversation: 5 terminal Turns / 40 Pi entries / 63371 bytes
- Kafka AcceptedFacts / canonical Session heads: 25788 / 101
- PostgreSQL hot-event table absent / projected Session mutations: true / 101
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the conversation did not implicitly own or destroy that Workspace runtime, and explicit eviction removed it. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
