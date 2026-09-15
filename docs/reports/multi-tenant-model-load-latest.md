# Multi-tenant real-model load acceptance

- Checked at: 2026-09-15T02:13:13.521Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Sessions / Runs: 4 / 16 / 32
- Peak claimed-to-settled Run overlap: 16
- Completed / failed: 32 / 0
- Marker restores / cross-tenant leaks: 16 / 0
- Worker assignments: pi-cloud-worker-1=16, pi-cloud-worker-2=16
- Acceptance p50/p95: 80 / 173 ms
- First assistant text p50/p95: 1904 / 3209 ms
- Settled p50/p95: 2439 / 4221 ms
- Queue wait p50/p95: 555 / 1003 ms
- Terminal Turns / Pi entries / complete messages: 32 / 80 / 64
- Pi entries per Run / canonical payload bytes: 2.5 / 89153
- Real requests/input/output/cache-read tokens: 32 / 7580 / 6093 / 43008

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
