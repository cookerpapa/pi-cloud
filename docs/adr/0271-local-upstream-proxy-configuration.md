# ADR-0271: One operator command for the local upstream proxy

Status: implemented; applied to the current one-host deployment.
Date: 2026-10-22.

The owner changed the local proxy port from 10808 to 12450 and requested one
place to update PiCloud's addresses. The one-host installation already runs
the model host relay and Cube egress gateway in the host network, so both can
reach the same loopback HTTP proxy. Docker builds and host commands use it too.

Maintain `production:proxy [HTTP(S)_ORIGIN]` as a bounded operator command.
The private `runtime/upstream-proxy` file records the requested shared address.
The command persists the provider environment setting, applies it with the
existing infrastructure Helm release, updates Cube settings through the existing
authorized settings service, and updates Docker and K3s systemd proxy settings.
Preserve the Cube egress enabled/disabled choice. Build/release entry points and
an optional shell helper read the same private address instead of retaining stale
inherited proxy variables. Do not put local deployment addresses in source.

This is configuration synchronization, not an atomic distributed transaction or
a new proxy, daemon or configuration authority inside the runtime. PG remains
the authority for active Cube settings; Helm remains the provider deployment
description. Changing Cube settings independently remains supported. Applying the
shared setting again reconciles all destinations. Retrying an already applied
value must not restart Docker/Relay or increment the PG revision unnecessarily.

Preflight validates the address, connectivity and the existing operator identity.
Use the release lock to avoid racing publication. Report partial application as
failure so the same command can be rerun. Keep unrelated Helm values, secrets,
accounts and running Agent identities. Docker updates require normal host admin
access and no running Docker build/test containers. K3s environment updates use
the normal service restart with `KillMode=process` and no custom stop hooks;
running containers remain alive as described in the
[K3s stopping guidance](https://docs.k3s.io/upgrades/killall). The destructive
killall command is never used. Preserve non-proxy environment entries and
`NO_PROXY`, including K3s tokens, and verify process environments after restart.

Acceptance covers address serialization, stale environment replacement,
independent-setting preservation, repeated application, actual host/model/guest
connectivity, and removal of active 10808 configuration. Historical reports are
evidence and are not rewritten by a global replacement.

The current deployment uses `http://127.0.0.1:12450`, Cube settings revision 8,
with public egress still enabled. Reapplication retains Docker PID, model Relay
and Worker Pod/container identities and the PG revision. Host HTTPS, the model
Relay's provider TLS route and Cube egress HTTPS pass. npm audit again returns a
complete passing report. Docker's first restart outlasted the old 60-second
operator wait while BuildKit initialized; the daemon finished normally and the
operator now checks readiness within a bounded five-minute window. The initial
failure and successful reapplication are retained in private release evidence.
