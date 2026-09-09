# Multi-tenant real-model load acceptance

- Checked at: 2026-09-09T14:37:59.886Z
- Provider/model: deepseek / deepseek-v4-flash
- Tenants / Runs: 4 / 8
- Completed / failed: 8 / 0
- Marker restores / cross-tenant leaks: 4 / 0
- Worker assignments: pi-cloud-worker-1=4, pi-cloud-worker-2=4
- Acceptance p50/p95: 38 / 51 ms
- First assistant text p50/p95: 1472 / 4191 ms
- Settled p50/p95: 2778 / 6121 ms
- Queue wait p50/p95: 28 / 3165 ms
- Terminal Turns / Pi entries / complete messages: 8 / 20 / 16
- Pi entries per Run / canonical payload bytes: 2.5 / 16099
- Real requests/input/output/cache-read tokens: 8 / 632 / 867 / 47616

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
