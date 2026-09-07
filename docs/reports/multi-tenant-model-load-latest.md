# Multi-tenant real-model load acceptance

- Checked at: 2026-09-07T04:53:10.490Z
- Provider/model: openai-codex / gpt-5.6-terra
- Tenants / Runs: 3 / 6
- Completed / failed: 6 / 0
- Marker restores / cross-tenant leaks: 3 / 0
- Worker assignments: pi-cloud-worker-2=4, pi-cloud-worker-1=2
- Acceptance p50/p95: 22 / 28 ms
- First assistant text p50/p95: 3413 / 9197 ms
- Settled p50/p95: 6749 / 13618 ms
- Queue wait p50/p95: 231 / 6493 ms
- Terminal Turns / Pi entries / complete messages: 6 / 15 / 12
- Pi entries per Run / canonical payload bytes: 2.5 / 13873
- Real requests/input/output/cache-read tokens: 6 / 17673 / 568 / 35328

Every tenant used an independent API credential, Project, Workspace and Pi SessionStorage state. All first and follow-up Runs were submitted concurrently through the shared PostgreSQL queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.
