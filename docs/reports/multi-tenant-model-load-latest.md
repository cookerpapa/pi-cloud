# Multi-tenant real-model load acceptance

- Checked at: 2026-09-16T00:09:25.337Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Sessions / Runs: 4 / 8 / 16
- Peak claimed-to-settled Run overlap: 8
- Completed / failed: 16 / 0
- Marker restores / cross-tenant leaks: 8 / 0
- Worker assignments: pi-cloud-worker-2=8, pi-cloud-worker-1=8
- Acceptance p50/p95: 42 / 120 ms
- First assistant text p50/p95: 1684 / 2550 ms
- Settled p50/p95: 2035 / 3703 ms
- Queue wait p50/p95: 418 / 842 ms
- Terminal Turns / Pi entries / complete messages: 16 / 40 / 32
- Pi entries per Run / canonical payload bytes: 2.5 / 43866
- Real requests/input/output/cache-read tokens: 16 / 3052 / 3068 / 25600

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
