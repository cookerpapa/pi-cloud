# Pi Worker pool production acceptance

- Checked at: 2026-10-10T10:41:36.905Z
- Provider/model: openai-codex / gpt-6-luna
- Worker deployment: kubernetes
- Active Workers: pi-cloud-pi-worker-primary-v1-0, pi-cloud-pi-worker-primary-v1-1
- Cross-Worker restore: pi-cloud-pi-worker-primary-v1-1 -> pi-cloud-pi-worker-primary-v1-0
- PostgreSQL Pi Session restored: true
- Previous-turn marker recovered: true
- Active Worker crash terminal state: completed
- Original input retained across native recovery: 1
- Native recoveries after ordered closure: 1
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: pi-cloud-pi-worker-primary-v1-1, pi-cloud-pi-worker-primary-v1-0, pi-cloud-pi-worker-primary-v1-0, pi-cloud-pi-worker-primary-v1-0
- Real requests/input/output tokens: 8 / 22898 / 571

The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL Durable Storage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.
