# ADR-0320: Release plans separate artifacts, roles and physical maintenance

Date: 2026-11-12. Status: accepted for implementation. Tracking: #33 and #37.

## Decision

Keep the maintained matched/component operators and one candidate journal. A
shared policy describes reviewed source scopes, Docker input ownership, serving
roles, contract gates and physical maintenance. CI and manual publication use
that policy. An unclassified change remains conservative; a source classifier
never waives schema, ownership, native protocol or resource cleanup checks.

Artifact selection and role replacement are different decisions. Compute build
inputs from the actual pinned Dockerfile/COPY inputs and declared generated or
external inputs. Reuse an unchanged image only after checking its immutable ID,
original source/provenance, matching input identity and applicable evidence policy.
Do not relabel old bytes as newly built source. Reuse a scan only when immutable
image identity, scanner, policy files and recorded vulnerability/Java database
identities match; otherwise scan the retained image again. A previous manifest
without database identity cannot supply a reused scan. A shared host image may supply
several independently replaced roles; rebuilding it does not require replacing
every role which happens to use the same repository.

Every candidate records the baseline, changed files, built/reused artifacts,
affected roles, contract versions, drain/maintenance requirements and acceptance
scope. Print this plan before mutation. Interrupted apply resumes the same
candidate and verifies actual state. No blind rollback across schema/physical
ownership changes and no automatic reinitialization of an uncertain writer.

## Replacement boundaries

Retain the verified Web, provider/catalog, ordinary Tool-host, Session API,
Session decoder/retention and Worker bootstrap paths. Close CI gaps where those
same paths currently fall into an unrelated full image matrix. Additional role
scopes must prove their retry/recovery boundary before live use; unknown or shared
contracts coordinate every actual participant.

Compatible application replacement does not retire native compute or touch
Workspace files. Native/Guest/storage ownership changes still require the recorded
physical retirement and cold guards. ADR-0318 requires a cold adoption of existing
generations/pool identity and retirement of old native registrations only after
the new registration-only Destroy hook is active. The latter cannot delete bytes.
Completed extension-table removal/legacy holder initialization are removed from
ordinary publication; ongoing exact-holder and original-operation checks remain.

Informational chart labels belong to resource metadata. Pod templates contain
only relevant rollout inputs, so changing a root chart version does not replace
unrelated workloads. Compatible registry changes are data operations under
ADR-0319, not publication. Optional native adapters use their maintained scoped
operator and explicit registry, not a global provider-mode switch.

## Evidence and validation

Reuse Git object identities, Docker image digests, Helm manifests and the existing
scan/replacement journals. These already cover the bounded deployment; a new
deployment framework or reconciliation authority would duplicate them.

Verify pure impact cases, source closure, original evidence reuse, changed shared
contracts, metadata-only renders, interrupted apply and physical maintenance
selection. Serial live checks must demonstrate a Web-only replacement, a permitted
Tool-host/role replacement with the original Session writer retained, and dynamic
backend registration without existing Pod restarts. Keep all original assets and
report measured build/rollout scope, not a theoretical speedup.
