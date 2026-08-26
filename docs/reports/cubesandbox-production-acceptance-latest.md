# CubeSandbox production acceptance

- Checked at: 2026-08-26T10:11:45.782Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1799 ms / 2318 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 11355 ms / 12937 ms
- Follow-up first text / settled: 6144 ms / 7986 ms
- Coding Tool calls: 2 + 2
- Same running Session Cube KVM guest reused: true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 148485 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 1439 / 1730 / 82816
- Canonical conversation: 3 terminal Turns / 17 Pi entries / 14116 bytes
- Kafka AcceptedFacts / canonical Session heads: 13856 / 22
- PostgreSQL hot-event table absent / projected Session mutations: true / 44
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
