# Pi Worker pool production acceptance

- Checked at: 2026-09-16T13:41:56.371Z
- Test / Control Plane revision: `c28ce385`; Kubernetes Worker revision: `ae5c5ff3`.
- Provider/model: deepseek / deepseek-v4-pro
- Worker deployment: kubernetes
- Active Workers: pi-cloud-pi-worker-local-v1-0, pi-cloud-pi-worker-local-v1-1
- Cross-Worker restore: pi-cloud-pi-worker-local-v1-1 -> pi-cloud-pi-worker-local-v1-0
- PostgreSQL Pi Session restored: true
- Previous-turn marker recovered: true
- Active Worker crash terminal state: failed
- Accepted prefix projected after crash: true
- Projected predecessor seals: 1
- Concurrent Runs / distinct Workers: 4 / 2
- Concurrent assignment: pi-cloud-pi-worker-local-v1-1, pi-cloud-pi-worker-local-v1-0, pi-cloud-pi-worker-local-v1-1, pi-cloud-pi-worker-local-v1-1
- Real requests/input/output tokens: 7 / 591 / 1204

The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL SessionStorage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.
