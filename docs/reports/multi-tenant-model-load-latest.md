# Multi-tenant real-model load acceptance

- Checked at: 2026-09-08T17:17:50.151Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 4 / 8
- Completed / failed: 8 / 0
- Marker restores / cross-tenant leaks: 4 / 0
- Worker assignments: pi-cloud-worker-2=4, pi-cloud-worker-1=4
- Acceptance p50/p95: 95 / 151 ms
- First assistant text p50/p95: 2284 / 3076 ms
- Settled p50/p95: 3099 / 4966 ms
- Queue wait p50/p95: 205 / 937 ms
- Terminal Turns / Pi entries / complete messages: 8 / 20 / 16
- Pi entries per Run / canonical payload bytes: 2.5 / 17602
- Real requests/input/output/cache-read tokens: 8 / 801 / 986 / 47488

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
