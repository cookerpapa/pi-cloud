# ADR-0217: one rendered Cube release

Status: implemented, deployed and verified, 2026-10-03. The owner approved optimizing
[review D03-01/02](../reports/repository-review-20261003.md) after discussing the
Helm/post-install drift and the maintenance responsibility of the Cube extension.
[Acceptance](../reports/review-repair-20261003.md).

## Decision and reuse

Keep the pinned Cube runtime, four native patches, existing trusted completion
adapter, guest tools and physical-resource authorities. Use Helm's supported
[post-renderer](https://helm.sh/docs/topics/advanced/#post-rendering) to complete
the manifest **before** installation. The installed tool is Helm 3.18.6, also
pinned by the self-hosted installer. Helm is Apache-2.0 licensed and is already
our deployment authority. Kustomize could perform static YAML patches, but the
small existing config/credential transforms already require pinned source inputs;
adding another configuration layer would not remove that work. Reuse the current
pinned YAML parser and bounded pure transforms, not a new deployment controller.

The render input consists of the pinned Git Cubelet config/chart, PiCloud POSIX
plugin, recorded Workspace host root/inode identity, and existing completion
credentials/Service names. Do not read a running container's config to construct
the desired state. Temporary render inputs are private and removed after Helm.
Helm owns the final Master Secret, plugin ConfigMap, completion Secret, mounts,
completion environment and image versions together. Normal upgrades and rollback
therefore retain one rendered release history instead of an out-of-band patch.

Parse Kubernetes input using YAML 1.1 and emit JSON documents so quoted `off/on`
strings and octal file modes keep their types. The embedded Master YAML uses the
same schema. Both deployment entry points perform a server-side dry run inside
the renderer before Helm can apply the release. Validation failure emits neither
a partial manifest nor secret-bearing diagnostics. Offline render checks remain
available without cluster access.

Both full Cube installation and completion-configuration reconciliation use the
same renderer. The latter upgrades the existing release with retained values; it
must not reset API/Master/Cubelet images to upstream defaults. Existing named
PiCloud ConfigMap/Secret resources are adopted by Helm after checking that they
are not owned by another release. Remove the old post-deployment patches.

All operators modifying this release must use the maintained renderer/pipeline;
Helm does not enforce that an arbitrary command uses it. Existing native-version,
completion-source and Workspace-mount preflight checks remain. A successful
render does not establish that an arbitrary runtime image contains the required
native patch. No image/version fallback is added.

Narrow the completion image's database code dependency to the connection adapter
it actually uses. Database migrations and unrelated authority services must not
be copied into Cubelet just because its completion uploader needs PostgreSQL.
Root lockfile/dependency inputs remain pinned; native patch, guest and completion
identities retain their separate purposes. No promise of effortless upstream
Cube upgrades or cross-boot result recovery is made.

## Acceptance and rollout

Render the real pinned chart and assert exact final mounts, configuration, images,
credential placement and ownership. Repeated rendering is deterministic and
idempotent; fail closed on unexpected chart/config shapes. Confirm installer and
ordinary reconciliation share the path and have no later workload patch. Test
changed credentials/configuration fingerprints without starting a second owner.
Before any live Cube replacement, confirm quiescence and empty VM inventory,
preserve Volume/conversation data and save the existing release. Deploy matched
application/completion images and verify real file/image execution. Helm rollback
uses the stored rendered release; rollback to a pre-cutover release requires the
old complete installer, not an unrendered chart upgrade.
