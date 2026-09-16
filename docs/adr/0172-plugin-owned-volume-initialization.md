# ADR-0172: plugin-owned Volume initialization

Status: accepted and implemented, 2026-09-16; deployed acceptance pending.

## Decision

Cube's POSIX Volume Plugin owns storage initialization. PostgreSQL remains the
authority for Workspace/tenant ownership and deletion intent; Cube owns Volume
registration and mount references. The Volume Gateway verifies identity and reads
current files, not a second initialization state machine.

Replace `volume-state.json` plus `generation` with one immutable `identity` file
outside the guest mount. It contains only a format version, Volume ID and storage
incarnation. Create writes a private temporary file, syncs it, publishes with a
no-overwrite hard link and syncs directories. A per-Volume filesystem lock covers
plugin lifecycle preparation and stale temporary-file cleanup, not Agent file
editing. Repeated Create validates and reuses the existing identity and never
clears user bytes. PiCloud verifies the complete identity before creating a Cube
that mounts it; partial/unsupported layouts fail explicitly. Node mount/detach
wire fields are unchanged. No old-layout decoder or migration is added.

Keep the separate, later `delete-authorized` record: zero Cube mount references
do not express a PiCloud user's deletion intent. The trusted Gateway grants
deletion after the existing PG checks, and the privileged Controller hook verifies
that grant against the immutable identity. Interrupted deletion retains its grant
until user bytes are gone; finalization removes only the trusted envelope.

Metadata presence is not proof that guest seed/setup work completed. Remove the
`attached` boolean's control over guest initialization. Persistent directories
must never be cleared to apply an empty or sample seed. Test/demo initialization
must be explicit and non-overwriting; validation still runs on actual activation.

## Adopt before build

Cube v0.6.0's [Volume contract](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/volume-plugin.md)
already delegates backend creation to the plugin. Its `private_data` is forwarded
to Attach, not exposed to ordinary SDK reads or passed to Destroy, so it cannot
replace every local identity check without changing Cube's own contract.

Use existing POSIX file publication and the standard Linux `flock`/`ln`/`sync`
utilities, as appropriate to the deployment's shared filesystem. A single file
needs neither a custom `renameat2` binding nor a multi-file transaction framework.
No copy/delete fallback is permitted when atomic link or durability operations
are unsupported. This does not make Cube's database plus plugin effects one
transaction, certify every shared filesystem, or restore guest process memory.

## Acceptance and cutover

Test actual plugin Create/Attach/Destroy, concurrent creation, interruption before
and after identity publication, reuse without overwriting, stale deletion grants,
nonempty/unknown layouts, symlink boundaries, root-owned deletion and lost replies.
Exercise the real guest initialization code under concurrent writes; no existing
file may be removed or replaced. Verify Gateway reads perform no initialization.

This changes the plugin/Gateway storage contract. Drain and explicitly retire
identified old-layout test resources before deploying matching plugin, Gateway
and guest code. Do not silently migrate or delete real user data. Keep production
on the previous coherent set until the privileged plugin update is available.
