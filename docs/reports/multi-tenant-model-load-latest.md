# Multi-tenant real-model load acceptance

PostgreSQL CPU ceiling: 4 cores on the shared one-host deployment.

- Checked at: 2026-09-17T00:06:21.530Z
- Provider/model: deepseek / deepseek-v4-pro
- Tenants / Sessions / Runs: 4 / 8 / 16
- Peak claimed-to-settled Run overlap: 8
- Completed / failed: 16 / 0
- Marker restores / cross-tenant leaks: 8 / 0
- Worker assignments: pi-cloud-pi-worker-local-v1-0=8, pi-cloud-pi-worker-local-v1-1=8
- Acceptance p50/p95: 48 / 165 ms
- First assistant text p50/p95: 1461 / 2053 ms
- Settled p50/p95: 2270 / 4781 ms
- Queue wait p50/p95: 251 / 395 ms
- Terminal Turns / Pi entries / complete messages: 16 / 40 / 32
- Pi entries per Run / canonical payload bytes: 2.5 / 31954
- Real requests/input/output/cache-read tokens: 16 / 1832 / 2055 / 30720

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
