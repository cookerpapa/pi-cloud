# CubeSandbox production acceptance

- Checked at: 2026-08-26T06:45:17.595Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 2856 ms / 3237 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 1627 ms / 14092 ms
- Follow-up first text / settled: 7151 ms / 8542 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 154715 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2185 / 2000 / 92800
- Canonical conversation: 3 terminal Turns / 19 Pi entries / 19034 bytes
- JetStream Agent events / Session mutations / pending mutation ACKs: 2056 / 244 / 0
- PostgreSQL hot-event table absent / projected Session mutations: true / 49
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
