# CubeSandbox production acceptance

- Checked at: 2026-08-28T16:22:20.067Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first activity / assistant text / settled: 1639 / 1639 / 2066 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 25 / 225 / 1297 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 3414 / 3414 / 7802 / 9241 ms
- Follow-up first activity / Tool / assistant text / settled: 1634 / 1634 / 7502 / 8641 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 16 / 187 / 5238 / 2621 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 18 / 255 / 5613 / 1216 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Agent Preview / background process survived repeated Run handoffs: true / true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 148558 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 4145 / 3815 / 154112
- Canonical conversation: 5 terminal Turns / 36 Pi entries / 30418 bytes
- Kafka AcceptedFacts / canonical Session heads: 6033 / 11
- PostgreSQL hot-event table absent / projected Session mutations: true / 92
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
