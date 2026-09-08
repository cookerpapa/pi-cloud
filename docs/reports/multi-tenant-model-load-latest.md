# Multi-tenant real-model load acceptance

- Checked at: 2026-09-08T06:34:56.919Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 3 / 6
- Completed / failed: 6 / 0
- Marker restores / cross-tenant leaks: 3 / 0
- Worker assignments: pi-cloud-worker-2=3, pi-cloud-worker-1=3
- Acceptance p50/p95: 29 / 34 ms
- First assistant text p50/p95: 1591 / 5169 ms
- Settled p50/p95: 3260 / 7870 ms
- Queue wait p50/p95: 20 / 4049 ms
- Terminal Turns / Pi entries / complete messages: 6 / 15 / 12
- Pi entries per Run / canonical payload bytes: 2.5 / 14716
- Real requests/input/output/cache-read tokens: 6 / 740 / 992 / 35456

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
