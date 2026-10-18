# Native Tool settlement repair

Date: 2026-10-18. Plan: [ADR-0255](../adr/0255-native-tool-result-boundaries.md).
The owner approved WHS-01/02/03 and selected native Pi default limits. Source
implementation `f6986780` passes all required repository, transport and fault
checks. Matched release `tool-settlement-20ac9696` is deployed, relevant live
acceptance passes and owned fixture cleanup is complete.

## Implemented source behavior

- Coordination result admission uses 50 KiB of actual UTF-8 text and 2,000 lines,
  including Pi's trailing-LF convention. Structured values are serialized once;
  outer transport escaping no longer consumes a separate 256 KiB text budget.
  Oversize results/errors return a bounded diagnostic before native truncation.
  Guest workflow and trusted receiver boundaries share the policy. Subagent
  input budgets remain separate.
- Supervisor results keep their selected text and useful metadata, dropping
  duplicate output/reply text from `details`. Metadata is separately bounded;
  hostcall values are validated before the small execution-reference wrapper.
- Empty committed observer notifications do not read Entry bodies or sequences.
  Entry progress still advances. Sequence reads use acknowledged local metadata
  or a scoped `seq` query, without history bodies or image downloads.
- Native guest and packed Kafka result shapes are distinct PiCloud schemas.
  Text/normalized image/reference structure is checked before known settlement;
  malformed mailbox results receive the existing protocol-error classification.
  Empty content, diagnostics and opaque details remain supported.
- Review probes are archived in `f1d7dbbe`; their evidence remains in the review
  JSON. Maintained native, PG and protocol regressions replace bug expectations.

## Verification progress

Targeted native Harness, real PG metadata, workflow, protocol, completion and
mailbox verification passes 89 tests. Initial failures were fixture expectations: Vitest
spread an array case into arguments, a SQL fixture lacked a result-row type, and
the old progress-reply test expected the former generic error instead of the new
typed protocol error. Corrections retain valid-content, native-boundary and
no-replay assertions. Maintained tests also confirm metadata reads stay behind
publication acknowledgement and reject a poisoned owner after ACK uncertainty.

Full `npm run ci` passes on clean source `f69867806506adc53925010f500817f8ababe8e0`:
1,855 workspace tests, 77 helper tests, nine real RF3/PG transport tests and all
279 indexed fault cases. Types, builds, dependency hardening, formatting/docs,
installer, runtime policy, native Cube admission/allocation/Volume contracts,
Helm, observability and image closure pass. The npm security audit has no remaining
vulnerabilities. Separate browser-presentation, Docker context and native template
cleanup checks also pass. Artifact scans and live acceptance are recorded
separately below.

KVM API 12 and actual empty-VM creation are verified. The private release directory
`deploy/production/runtime/release-evidence/tool-settlement-20261018/` records the
idle native/control inventory and seven original configuration fingerprints:
32 tenants/users/API credentials, five password credentials and 35 model profiles/
credential bindings. All seven fingerprints still match after live acceptance
and cleanup.

## Artifacts and matched deployment

The application/native artifacts use version `tool-settlement-20ac9696` and source
`20ac9696604f6e15adf01938f273b2fe31f8c211`. This adds verification documentation
to the tested runtime implementation `f6986780`.

All eleven artifacts pass the existing SBOM/provenance/vulnerability gate, with
zero fixable HIGH/CRITICAL findings under its unchanged policy. Unfixed findings
remain reported. The guest identity is `5d775367299e1cfc7877a2bf2544f857f4690f08`,
with registered OCI digest
`sha256:49b703d8cc91ef3c21fcb4df670ab2f71ddb8e91b5e7bc46930df870739a7503`.
Completion identity is `41871c26571c6721c0e791a14fbd892abbb80761`.

The maintained operator rechecked KVM, exact artifact/source identity, settled
writers and complete native inventory before cutover. All four templates and
matched services are deployed. Schema 189, execution topic v17, reply v3,
guest/Tool protocol 7, completion startup 3, preview 2 and Cube management 7
remain unchanged. The valid wire layouts are unchanged; result validation and
admission behavior were replaced together without a compatibility branch.

Docker's configured proxy at `127.0.0.1:12450` was not listening, while the shell's
HTTP proxy at `127.0.0.1:10808` could reach the registry. Slow metadata lookups
delayed the build. A temporary `systemd-socket-activate`/`systemd-socket-proxyd`
forward restored access without changing daemon settings. It was stopped and its
listener confirmed absent before deployment/live acceptance. The permanent host
proxy setting remains a separate operational backlog item.

Before live testing, the new fixture's initially generated tenant slug was found
to be 66 characters, exceeding the 64-character admission limit. Test-only commit
`0d50846b` shortens the prefix and records the script hash. Its only changed file
relative to the deployed source is the host-side acceptance driver; runtime
sources/artifacts are unchanged. Live acceptance uses that corrected test revision.

## Live acceptance

Every live model case uses GPT-6 Luna and owned fixtures:

| Check | Evidence |
| --- | --- |
| Coordination boundaries | A 48,033-byte JSON result remains complete. A 51,201-byte return and a 2,001-line return each yield a 230-byte explicit error. All three workflow Tools are called once; both overflow markers confirm exactly one effect. |
| Supervisor exchange | A fresh child asks its parent for a decision; `contact_supervisor` receives the exact approved reply, and the parent completes through `subagent_supervisor`. |
| Native input and recovery | All five cases pass: queue edits/retry identity/consumption, Stop restoration, Worker replacement, streaming Stop, and simultaneous Worker/Control Plane memory loss. Observed text survives in the same logical Run, with streaming bodies outside PG. |
| Browser and Read | Real-browser lost admission reply, draft removal, Stop/returned-image resend and direct vision pass. ASCII/Unicode Read prefixes preserve native truncation diagnostics and valid UTF-8. |
| Tool images | 6,294,333-, 6,294,508- and 25,129,479-byte images return successfully; image-bearing native log records are 596, 596 and 597 bytes. Immutable content and visual recall survive Worker replacement and overwritten source files. |
| Child across Control Plane replacement | Replacement takes 14,003 ms; the original Worker remains, the child Bash executes once and the parent control reply completes through Kafka. |
| Full Cube | Pure chat avoids Cube; multi-round coding, preview, background processes, tenant isolation, a 1,024-file fixture on a persistent Volume, fresh-VM restoration and rejection of late commands to a deleted VM all pass. |

Private reports are `coordination.json`, `native-input.json`, `browser-images.json`,
`tool-images-20261018.json` and `child-20261018.json` under the release directory.
The [full Cube report](cubesandbox-production-acceptance-latest.md) and
[JSON evidence](cubesandbox-production-acceptance-latest.json) record the test
revision and deployed Control Plane image. All live checks pass on their first
executed attempt; the slug correction was made before invoking its fixture.

## Cleanup and final state

Normal APIs closed/deleted owned Sessions and Workspaces before physical purge.
Native checks confirmed no Volume, attachment holder or open/non-absent allocation.
Owned temporary tenants were removed with the existing helper. The three recorded
Tool-image objects were deleted only after locking their metadata and confirming
no native references/uploads/unsealed source Run. Three physically purged
bootstrap-tenant fixture projects/Workspaces were removed afterward.

Final inventory scans the sole native node and finds zero VMs. Active Runs,
writers, bindings, runtime/machine/terminal lifetimes and pending control records
are zero. No test Session, Workspace, project, image object/reference or upload
remains. All serving Pods are Ready and original account/model/provider/credential
fingerprints match `before.json`. The release preserves native ownership guards;
it does not claim fleet scale, physical-node HA or lossless arbitrary shell effects.
