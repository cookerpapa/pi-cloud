# CubeSandbox production acceptance

- Checked at: 2026-08-26T04:28:53.897Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 3117 ms / 3428 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 945 ms / 16827 ms
- Follow-up first text / settled: 1040 ms / 7278 ms
- Coding Tool calls: 5 + 3
- Same running Session Cube KVM guest reused: true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 149595 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2681 / 2279 / 108416
- Canonical conversation: 3 terminal Turns / 25 Pi entries / 21938 bytes
- JetStream Agent events / Session mutations / pending mutation ACKs: 1564 / 158 / 0
- PostgreSQL hot-event table absent / projected Session mutations: true / 64
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
