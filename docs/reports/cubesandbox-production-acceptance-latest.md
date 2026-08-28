# CubeSandbox production acceptance

- Checked at: 2026-08-28T17:29:54.408Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first activity / assistant text / settled: 1268 / 1268 / 1608 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 25 / 168 / 931 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first activity / Tool / assistant text / settled: 3119 / 3119 / 8226 / 9519 ms
- Follow-up first activity / Tool / assistant text / settled: 1887 / 1887 / 5234 / 6424 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 24 / 201 / 4799 / 3120 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 17 / 157 / 3996 / 976 ms
- Coding Tool calls: 2 + 2
- Same running Session Cube KVM guest reused: true
- Agent Preview / background process survived repeated Run handoffs: true / true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 153597 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2350 / 2537 / 136192
- Canonical conversation: 5 terminal Turns / 34 Pi entries / 27110 bytes
- Kafka AcceptedFacts / canonical Session heads: 7865 / 30
- PostgreSQL hot-event table absent / projected Session mutations: true / 87
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
