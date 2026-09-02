# Multi-tenant real-model load acceptance

- Checked at: 2026-09-02T03:39:56.769Z
- Provider/model: openai-codex / gpt-5.6-terra
- Tenants / Runs: 12 / 24
- Completed / failed: 24 / 0
- Marker restores / cross-tenant leaks: 12 / 0
- Worker assignments: pi-cloud-worker-1=12, pi-cloud-worker-2=12
- Acceptance p50/p95: 108 / 432 ms
- First assistant text p50/p95: 14821 / 35654 ms
- Settled p50/p95: 16100 / 39879 ms
- Queue wait p50/p95: 12168 / 32345 ms
- Terminal Turns / Pi entries / complete messages: 24 / 60 / 48
- Pi entries per Run / canonical payload bytes: 2.5 / 60503
- Real requests/input/output/cache-read tokens: 24 / 39108 / 2412 / 172032

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
