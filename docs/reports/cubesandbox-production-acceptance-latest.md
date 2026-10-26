# CubeSandbox production acceptance

- Checked at: 2026-10-26T13:59:07.848Z
- Provider/model: openai-codex / gpt-6-luna
- Pure-chat first activity / assistant text / settled: 4628 / 4628 / 5035 ms
- Pure-chat accepted-to-execution / execution-to-settlement: 28 / 4754 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 11866 / 11866 / 37669 / 38723 ms
- Follow-up first activity / Tool / assistant text / settled: 6499 / 6499 / 27349 / 28536 ms
- First coding accepted-to-execution / native Tool boundaries: 63 / 5524.086 ms
- Follow-up accepted-to-execution / native Tool boundaries: 80 / 1843.71 ms
- Coding Tool calls: 3 + 3
- Same running Workspace Cube KVM guest reused: true
- Agent Preview / background process survived cross-Run Tool bindings: true / true
- Elastic runtime / final conversation deletion released its unused runtime: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files on the persistent Volume: 1025
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 41678 / 1901 / 128512
- Canonical conversation: 5 terminal Turns / 31 Pi entries / 43946 bytes
- Current Kafka topic / end-offset sum / completed work records: pi-cloud.execution-log.v18 / 35785 / 5
- PostgreSQL hot-event table absent / projected Session mutations: true / 155
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Final-conversation cleanup and confirmed native allocation closure / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the final conversation released its unused runtime. A separately owned cold-recovery fixture closed its native allocation and waited for the Control Plane to reconcile absence. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and confirmed native allocation closure were verified.
