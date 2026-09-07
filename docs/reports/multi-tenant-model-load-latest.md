# Multi-tenant real-model load acceptance

- Checked at: 2026-09-07T12:46:45.432Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 3 / 6
- Completed / failed: 6 / 0
- Marker restores / cross-tenant leaks: 3 / 0
- Worker assignments: pi-cloud-worker-2=1, pi-cloud-worker-1=5
- Acceptance p50/p95: 23 / 28 ms
- First assistant text p50/p95: 2103 / 7127 ms
- Settled p50/p95: 3462 / 10008 ms
- Queue wait p50/p95: 205 / 6086 ms
- Terminal Turns / Pi entries / complete messages: 6 / 15 / 12
- Pi entries per Run / canonical payload bytes: 2.5 / 11965
- Real requests/input/output/cache-read tokens: 6 / 11874 / 632 / 24320

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
