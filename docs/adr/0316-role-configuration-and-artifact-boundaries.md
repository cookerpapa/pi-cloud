# ADR-0316: Role-owned configuration and production artifacts

Date: 2026-11-12. Status: accepted; implemented and live-verified on 2026-11-13.
Tracking: #36 and #37; publication policy remains #33.

Each existing process loads only the settings and clients it consumes. Session
API does not require Worker enrollment configuration; Session runtime does not
load public registration, preview or SCM configuration; management does not load
the Session writer's Kafka/provisioning settings through a common API loader.
Small database/secret/URL parsers are shared without a catch-all role fallback.
Tool host, completion, metering and Worker retain their existing own entrypoints.

Provider execution/data construction is distinct from lifecycle/storage
construction. Both can reuse native mechanical adapters; a narrow consumer does
not gain VM lifecycle authority. Dynamic registered provider configuration and
Workspace persistence are separate follow-up slices in #30/#31.

Helm mounts and process environment follow the same role boundary. Existing
credential values and product identities are retained. Readiness covers required
owned dependencies, and failed construction closes every acquired resource.

Artifacts contain their role's actual production dependency/asset closure. Use
existing client subpaths and shared build layers. A shared image may still serve
several roles with independent immutable deployment references; no new process
is required merely for a narrower package boundary. Dependency/asset checks must
cover dynamic imports, native modules, Guest inputs and shutdown paths, not just
a static bundle's unused-code elimination.

The maintained image-closure check also inspects all ten Node role entrypoints
with the lockfile-pinned esbuild. It records imported and contributing source
separately, plus external/native imports; narrow API and ordinary Tool consumers
must not import provider assembly through a server barrel. An optional
`PI_CLOUD_ROLE_CLOSURE_REPORT` path saves the full source manifest. Docker COPY
identities in the release plan remain authoritative for artifact inputs, and
actual image boot/live acceptance covers runtime assets and external dependencies.
The six host roles retain shared build layers and independent serving references;
splitting them into six new images is not required for scoped replacement.
Worker copies only the three sandbox-client source files it imports. The file
gateway copies its twelve storage/HTTP source files. Both subsets are checked
against actual role imports and image startup, so provider implementation edits
do not become their Docker inputs merely through the package directory.

Validate role startup with unrelated fields absent, required fields invalid,
actual assembly/failure cleanup and the rendered environment/mounts. Verify the
Worker image without Control Plane/accounting code before retiring those build
inputs. Keep protocol/schema/ownership changes coordinated and preserve exact
source/digest evidence for unchanged artifacts.

This refactors existing configuration and image construction. It adopts no new
deployment framework, scheduler or cache and adds no second resource authority.

Implementation and measured limits: [November 13 delivery](../reports/decoupling-delivery-20261113.md).
