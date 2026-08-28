# CubeSandbox production acceptance

- Checked at: 2026-08-28T08:02:27.638Z
- Provider/model: deepseek / deepseek-v4-flash
- Pure-chat first text / settled: 1908 ms / 2405 ms
- Pure-chat queue-to-claim-start / claim-and-preparation / model: 40 / 674 / 858 ms
- Pure-chat Tool calls / Cube activations: 0 / 0
- First coding first text / settled: 12306 ms / 13550 ms
- Follow-up first text / settled: 7931 ms / 10175 ms
- First coding queue-to-claim-start / claim-and-preparation / model / Tool: 25 / 564 / 7389 / 3833 ms
- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: 37 / 526 / 3202 / 1437 ms
- Coding Tool calls: 2 + 3
- Same running Session Cube KVM guest reused: true
- Elastic Sandbox policy / warm archive cleanup: true / true
- Workspace restored across Runs: true
- Trusted Git metadata sibling / user .git absent: true / true
- Large Workspace files / Volume reference: 1025 / 154704 bytes
- Large Workspace fresh-VM cold restore: true
- Real input/output/cache-read tokens: 2099 / 1911 / 86528
- Canonical conversation: 3 terminal Turns / 19 Pi entries / 18338 bytes
- Kafka AcceptedFacts / canonical Session heads: 1420 / 9
- PostgreSQL hot-event table absent / projected Session mutations: true / 49
- Scheduler / Worker pool: PostgreSQL / shared
- Cross-tenant conversation hidden: true
- Explicit warm eviction / remaining Cube microVMs: true / 0

A real-model chat Run completed without touching Cube. Two elastic coding Runs reused one bounded-warm Session Cube with rotated Tool authority and higher-fence rebind; archiving the conversation reaped that Cube. Platform Git metadata was verified in the trusted Volume envelope while the user Workspace contained no platform-created .git entry. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a higher-fence activation. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.
