# Multi-tenant real-model load acceptance

- Checked at: 2026-08-31T14:25:45.389Z
- Provider/model: openai-codex / gpt-5.6-terra
- Tenants / Runs: 6 / 12
- Completed / failed: 12 / 0
- Marker restores / cross-tenant leaks: 6 / 0
- Worker assignments: pi-cloud-worker-1=6, pi-cloud-worker-2=6
- Acceptance p50/p95: 81 / 336 ms
- First assistant text p50/p95: 6928 / 20901 ms
- Settled p50/p95: 8427 / 23263 ms
- Queue wait p50/p95: 4148 / 13839 ms
- Terminal Turns / Pi entries / complete messages: 12 / 30 / 24
- Pi entries per Run / canonical payload bytes: 2.5 / 43436
- Real requests/input/output/cache-read tokens: 12 / 28204 / 1150 / 25088

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
