# Multi-tenant real-model load acceptance

- Checked at: 2026-08-30T16:52:31.699Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: pi-cloud-worker-2=6, pi-cloud-worker-1=6
- Acceptance p50/p95: 45 / 148 ms
- First assistant text p50/p95: 2997 / 8004 ms
- Settled p50/p95: 4027 / 10408 ms
- Queue wait p50/p95: 2057 / 7066 ms
- Terminal Turns / Pi entries / complete messages: 12 / 30 / 24
- Pi entries per Run / canonical payload bytes: 2.5 / 21338
- Real requests/input/output/cache-read tokens: 12 / 1050 / 1264 / 67584

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
