# Multi-tenant real-model load acceptance

- Checked at: 2026-09-10T11:22:14.729Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Sessions / Runs: 6 / 18 / 36
- Completed / failed: 36 / 0
- Marker restores / cross-tenant leaks: 18 / 0
- Worker assignments: pi-cloud-worker-2=32, pi-cloud-worker-1=4
- Acceptance p50/p95: 261 / 667 ms
- First assistant text p50/p95: 13378 / 45204 ms
- Settled p50/p95: 13922 / 46630 ms
- Queue wait p50/p95: 12475 / 43109 ms
- Terminal Turns / Pi entries / complete messages: 36 / 90 / 72
- Pi entries per Run / canonical payload bytes: 2.5 / 96914
- Real requests/input/output/cache-read tokens: 36 / 7945 / 6464 / 200448

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
