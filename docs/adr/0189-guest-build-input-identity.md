# ADR-0189: guest build-input identity

Status: accepted and implemented, 2026-09-26.
Validation: [Pi-alignment repairs](../reports/pi-alignment-repair-20260926.md).

Guest template reuse is keyed by a digest of its Dockerfile and explicit local
COPY inputs, including source bytes, paths, executable bits and symbolic-link
targets. Referenced immutable base images, upstream versions and build recipes
are part of the Dockerfile input. The 40-hex runtime imageRevision is a build-input
identity, distinct from the platform Git revision used by application image labels.
It is not a new Workspace or Session checkpoint authority.

Keep the clean-checkout requirement, actual built image digest, Cube template
specification digests, READY checks and runtime image/guest protocol verification.
The digest selects reuse; it does not claim reproducible package repositories or
replace the built-image digest. Template registration explicitly builds the pinned
recipe; local COPY syntax not understood by the digest helper fails closed.

A frontend/documentation-only change reuses an unchanged matching guest catalog.
A copied guest input change requires a new immutable image/template. Rollback
selects the previous compatible catalog/image identity, not an alias that rewrites
an old template. Development cutover rebuilds once; no legacy matching rule remains.

Acceptance: unrelated files do not change the guest identity; copied files,
Dockerfile, file modes and link targets do; templates must still match the
chosen runtime identity. Compose application labels retain the platform revision.
