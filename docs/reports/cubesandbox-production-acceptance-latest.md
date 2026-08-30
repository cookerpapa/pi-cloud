# CubeSandbox production acceptance

- Checked at: 2026-08-30T02:31:35.258Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first activity / assistant text / settled: 846 / 846 / 1175 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 18 / 153 / 606 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 4328 / 4328 / 8285 / 9669 ms
- Follow-up first activity / Tool / assistant text / settled: 1719 / 1719 / 7917 / 9420 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 10 / 151 / 6630 / 1875 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 35 / 277 / 5887 / 1637 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Agent Preview / background process survived repeated Run handoffs: true / true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Platform Git metadata absent / user-managed .git present: true / false
- Large Workspace files / Volume reference: 1025 / 869 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 5093 / 4480 / 214528
- Canonical conversation: 5 terminal Turns / 41 Pi entries / 37986 bytes
- Kafka AcceptedFacts / canonical Session heads: 4672 / 24
- PostgreSQL hot-event table absent / projected Session mutations: true / 105
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; that warm optimization could later be capacity-evicted, and archiving the conversation left no Cube. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
