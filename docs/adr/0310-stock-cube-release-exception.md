# ADR-0310: Owner-approved stock Cube image exception

Date: 2026-11-11. Status: accepted.

The owner explicitly approved publishing the unmodified official Cube images
reviewed in [the stock image report](../reports/stock-cube-source-20261111.md),
accepting their reported dependency findings for this private deployment. This
resolves the release decision in ADR-0309; it does not classify the findings as
fixed or prove they are harmless.

The exception applies only to the four exact official inputs and filesystem layer
hashes in `deploy/cubesandbox/release-exception.json`. A metadata-only publication
wrapper must preserve that filesystem and its upstream digest label. Image tags
alone cannot authorize an exception. Changed inputs and other application/Guest
images retain the normal zero-fixable-HIGH/CRITICAL gate.

Keep complete raw/policy vulnerability reports and record the accepted exception
in the checksum-covered release evidence. Publication rechecks the local image
identity, filesystem and the same recorded exception policy. Do not add a global
skip flag, suppress findings in Trivy or restore Cube source/dependency patches.

The existing matched release still drains writers and retires compute before
changing storage/protocols, preserves original user assets and completes relevant
live acceptance. Native provider uncertainty and unpriced compute observations
retain ADR-0309's contracts. This exception is not permission to weaken fencing,
replay unsafe Tools, discard unresolved resources or silently enable BoxLite.
