# CubeSandbox KVM acceptance

- Tested: 2026-09-17, single-host WSL/KVM
- Test source: `5163fa02`; guest template: `985a8508`
- Upstream: TencentCloud/CubeSandbox v0.6.0
- Profile: single-node local KVM validation
- Tenant microVMs: 2
- First / second Tool latency: 2,017 ms / 1,824 ms
- Total gate time: 17,011 ms
- Guest kernel distinct from host: true
- Forbidden platform endpoints denied: 3
- Public Internet reachable through the configured policy: true
- Private and platform egress denied: true
- Background process survived a Run boundary within warm TTL: true
- Revoked Tool authority rejected: true
- Dispatched cancellation retained UNKNOWN; explicit stop retired its binding
- Remaining **test-owned** microVMs: 0; three test Volumes deleted

The gate created real Cubelet/CubeShim KVM guests for two independent tenant
assignments, wrote different canaries to the same Workspace path, verified each
tenant could read only its own value, and reattached the same persistent Volume
after destroying one guest. A terminal exercised a third Volume. Within a
60-second warm TTL, a later binding retained the same Cube, PID and HTTP service;
the retired execution reference was rejected. This is not a promise to preserve
processes beyond idle expiry.

Guest HTTPS used the configured proxy. The first runs exposed an old upstream
proxy address; updating it to the owner's selected port restored connectivity
without restarting the egress service. Direct platform/metadata probes remained
denied. Cancellation followed a confirmed guest-side marker, so its result must
be UNKNOWN rather than "not executed". Exact tenant/Workspace inventory proved
VM absence before the three native Volumes and their directories were removed.

Earlier repetitions failed on the stale proxy and obsolete test expectations;
only the complete final repetition above is counted as passed. No model tokens
were consumed by this direct Provider gate.

This report proves the local KVM integration and isolation path. It does not
claim multi-node availability, node-loss recovery, rolling upgrades, production
storage durability, process recovery after guest destruction or public-SaaS
hardening.
