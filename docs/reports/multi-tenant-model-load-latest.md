# Multi-tenant real-model load acceptance

- Checked at: 2026-09-16T20:06:26.684Z
- Provider/model: deepseek / deepseek-v4-pro
- Tenants / Sessions / Runs: 4 / 8 / 16
- Peak claimed-to-settled Run overlap: 8
- Completed / failed: 16 / 0
- Marker restores / cross-tenant leaks: 8 / 0
- Worker assignments: pi-cloud-pi-worker-local-v1-0=8, pi-cloud-pi-worker-local-v1-1=8
- Acceptance p50/p95: 49 / 357 ms
- First assistant text p50/p95: 1842 / 2326 ms
- Settled p50/p95: 2484 / 4511 ms
- Queue wait p50/p95: 450 / 1020 ms
- Terminal Turns / Pi entries / complete messages: 16 / 40 / 32
- Pi entries per Run / canonical payload bytes: 2.5 / 37128
- Real requests/input/output/cache-read tokens: 16 / 1906 / 2389 / 30720

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
