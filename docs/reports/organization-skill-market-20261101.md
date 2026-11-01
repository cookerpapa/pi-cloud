# Organization Skill market — November 1, 2026

Web release `skill-market-ui-20261101` is deployed from `69df83df`, platform
Helm revision 138. [ADR-0291](../adr/0291-internal-skill-market.md) records the
owner's organization-only scope and retained installation/runtime boundaries.

## Delivered behavior

- Separate organization browsing and Installed views, with debounced search over
  the existing paginated metadata API. Rendering keeps one result page; package
  bodies are fetched only after opening details.
- Compact cards show the name, purpose, sharing origin and install state. Routine
  implementation explanations, digests and empty environment summaries are removed.
- Details preview instructions and supporting files, with scope/version controls.
  Secondary management actions live in More. Large text previews stay bounded;
  complete files and packages remain downloadable.
- Sharing accepts authored SKILL.md, local directories and exported file packages.
  Editing instructions retains supporting assets; a failed save retains the draft.
  The Web has no external catalog or GitHub import entry. Existing stored source
  provenance and the operator import API are unchanged.
- Personal and shared installations retain their server revision checks. A new
  shared package version does not automatically replace installations. Member
  and viewer controls preserve the existing authority rules.

This reuses PG/S3 package ownership, fixed Skill tools, per-Run selection and
Sandbox execution. No protocol, schema, dependency, provider or native Harness
change is included.

## Verification and publication

- Web types and 239 Web tests pass. The committed scoped release gate passed
  256 tests across 34 files, full chat/queue browser checks, the expanded Skill
  browser check and long-history layout checks.
- Skill browser cases cover later-page search and empty results, installed
  filtering, independent scopes, revision conflicts, stale version/list replies,
  supporting-file retention, local package import, viewer controls, failed reads,
  mobile layout and keyboard dialog closure.
- Web image build, SBOM/scans, scoped manifest preflight and publication passed.
  The Web gate now includes the maintained Skill browser acceptance script.
- Live browser acceptance used an owned organization and two distinct users.
  The owner shared instructions, installed an organization version, and published
  an update. The member previewed the shared version, installed the newer version
  personally, reloaded, disabled/enabled it, and removed only that personal copy.
  The organization installation retained its original version throughout.
- No Run or Workspace was needed for that live flow. Test users, credentials,
  catalog/install records and Skill objects were cleaned through the owned-fixture
  procedure. All 29 running Pods were Ready afterwards; all 28 non-Web Pod
  identities and all nine original allocation identities/generations/states were
  unchanged.

The first slice uses bounded sequential catalog pages for search; it does not
claim indexed server-side search or maintain a second catalog. A sparse match in
an extensive organization directory may require several metadata requests. Public
registries and organization membership-management UI remain separate work.
