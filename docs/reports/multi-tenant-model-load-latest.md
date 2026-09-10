# Multi-tenant real-model load acceptance

- Checked at: 2026-09-10T13:23:40.096Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Sessions / Runs: 6 / 18 / 36
- Peak claimed-to-settled Run overlap: 18
- Completed / failed: 36 / 0
- Marker restores / cross-tenant leaks: 18 / 0
- Worker assignments: pi-cloud-worker-2=17, pi-cloud-worker-1=19
- Acceptance p50/p95: 117 / 208 ms
- First assistant text p50/p95: 2620 / 4336 ms
- Settled p50/p95: 3429 / 5441 ms
- Queue wait p50/p95: 667 / 1426 ms
- Terminal Turns / Pi entries / complete messages: 36 / 90 / 72
- Pi entries per Run / canonical payload bytes: 2.5 / 100358
- Real requests/input/output/cache-read tokens: 36 / 7831 / 6859 / 200576

Each tenant used an independent API credential and Project/Workspace, with multiple independent Sessions. First and follow-up Runs were submitted in concurrent waves through the shared PG queue. Worker capacity and actual assignments are recorded, not assumed to be two capacity-one processes. Each follow-up restored only its own Session marker, foreign-tenant Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
