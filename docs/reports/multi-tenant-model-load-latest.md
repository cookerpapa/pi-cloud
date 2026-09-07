# Multi-tenant real-model load acceptance

- Checked at: 2026-09-07T23:37:26.699Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 3 / 6
- Completed / failed: 6 / 0
- Marker restores / cross-tenant leaks: 3 / 0
- Worker assignments: pi-cloud-worker-1=1, pi-cloud-worker-2=5
- Acceptance p50/p95: 43 / 87 ms
- First assistant text p50/p95: 2409 / 6298 ms
- Settled p50/p95: 3875 / 8957 ms
- Queue wait p50/p95: 742 / 5602 ms
- Terminal Turns / Pi entries / complete messages: 6 / 15 / 12
- Pi entries per Run / canonical payload bytes: 2.5 / 11405
- Real requests/input/output/cache-read tokens: 6 / 831 / 671 / 35328

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
