# ADR-0292: Repair existing ownership, release and capability boundaries

Status: implemented and deployed, 2026-11-01.

[Verification and matched delivery](../reports/review-repairs-20261101.md).

The owner approved R01–R08 in the [whole-repository review](../reports/repository-review-20261101.md).
Implement one complete slice at a time, then publish matched application, guest
and Cube artifacts. Preserve conversations, images, Workspace Volumes, machine
intent, accounts and configuration. These repairs add no scheduler, broker,
storage authority or Pi core patch.

## Decisions

- Confirmed lost Sandbox ownership is terminal for that controller. Propagate it
  to aggregate readiness and bounded process retirement; Kubernetes restart and
  the existing PG protocol recover ownership. Transient renewal errors before
  the locally confirmed deadline remain retryable. Neither proves VM absence.
- Bootstrap is for first installation. Existing installations use maintained
  matched/scoped operators, with release locking, draining and provenance.
  Legacy deployment entrypoints reject before mutation.
- Fork/prune validate targets through indexed navigation metadata and shared
  membership. Preserve native ID ordering separately from publication visibility;
  remove lifetime body scans and their functional ceiling.
- Worker Tools and Skills share effective capability rules based on accepted
  grants, role and catalog. Delegation policy is distinct from availability.
- Historical reading may freeze text/geometry, but not execution terminal status.
  Preserve selection and complete-copy semantics.
- Sandbox CONNECT keeps a bounded establishment deadline and a traffic-refreshed
  idle deadline. Remove the hidden total five-minute lifetime of active tunnels.
  Model-provider waiting is unchanged.
- Skill staging reuses guest OS-lock discipline and atomic publication. Reclaim
  only verified abandoned managed staging, never live or arbitrary user content.
- Maintained acceptance validates the current source/deployment contract;
  historical reports retain their original results. Measurement probes must prove
  they observe real operations. Remove superseded current guidance.

## Reuse and limits

Reuse PG ownership, Kubernetes restart, the existing history directory, Tool
capability schemas, Node socket idle timers and the installed guest `flock`.
These are bounded adapter repairs, not a new distributed queue, storage protocol
or competing lifecycle authority. Boot credential renewal, general compute-only
upgrade tooling, fleet benchmarks and alternate sandboxes remain separate work.

## Acceptance

Cover expired owner/readiness and bounded exit; installed bootstrap refusal before
writes; text-heavy and >10,000-node Fork/prune with measured reads; restricted
child/max/Ultra Skills; terminal status during selection/reading; active versus
idle tunnels; killed and concurrent Skill staging. Run source, real PG/RF3,
fault, Cube and browser gates, then matched provenance and owned live acceptance.
Preserve original assets and confirm physical cleanup before fixture record removal.
