# Multi-tenant real-model load acceptance

- Checked at: 2026-08-28T08:11:32.710Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: pi-cloud-worker-1=6, pi-cloud-worker-2=6
- Acceptance p50/p95: 60 / 81 ms
- First text p50/p95: 4335 / 11451 ms
- Settled p50/p95: 5363 / 15014 ms
- Queue wait p50/p95: 3205 / 8659 ms
- Terminal Turns / Pi entries / complete messages: 12 / 30 / 24
- Pi entries per Run / canonical payload bytes: 2.5 / 21986
- Real requests/input/output/cache-read tokens: 12 / 1050 / 1362 / 67584

Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
