# Post-Durable repair release

The owner-authorized release is deployed from `18defa3e` on October 6, 2026.
It includes the [review repairs](review-repair-20261006.md), bounded auxiliary
template cleanup (`61f7ec2f`) and the release dependency/provenance fixes.
[Machine-readable release evidence](review-release-20261006.json) records the
exact image IDs, templates, release revisions, checks and backup receipts.

## Deployed state

- Application Helm revision **25**, infrastructure **24**, Cube **49**.
- Schema **181**, two ready Workers, and all **32** publication partitions available.
- Application/provider images use `review-release-18defa3e`.
- Native Cube protocol remains **7**, guest protocol **3**. The native patch-set
  identity is `07964b1feb86cbb4`; the completion identity is
  `e8a9e29eec723e694a51d41d394bb3f29fc4cfbe`.
- Guest build identity `1f7649a81c99c671770d3ef2bc09480dadd93847`, full image digest
  `sha256:c4ba840fa81fca8833e916aaa68228bc2ccfc4243e860cc3e0c7a99d592d054f`.
  Agent and all three development profiles have ready matching templates.

Old Workers, Projector and Gateways were drained before migration. The new Gateway
uses `Recreate`, preventing overlap between the old PG lock and new filesystem lock.
Private backups preserve the schema-180 database, Workspace/provider bytes,
configuration and eight attachment objects totaling 100,603,669 bytes. The PG
archive was checked with `pg_restore --list` in the pinned PostgreSQL image.
There was no database reset, Kafka topic change or dispatch-offset rewind.

## Release preparation

The first image build exposed an obsolete Debian PCRE package pin, while actual
image scans found fixable OS and Go dependency findings beyond the passing npm
audit. Explicit PCRE/Perl/OpenSSL pins, Cube module checksums and its Go toolchain
were updated. CLIProxyAPI retains its pinned source and model catalog, with the
affected go-git/crypto dependencies updated. The additional Cube patch changes
dependencies and build inputs; execution/lifecycle protocols remain unchanged.

Cube execution/admission/cancellation and actual-MySQL allocation/Volume contracts
pass with the new dependency set. Build context, image closure, runtime policy,
installer and documentation checks pass. Full Guest template checks pass, followed
by actual KVM execution after deployment.

The matched image collector now follows production version tags, verifies native
OCI provenance and locates the guest by its build-input identity. The complete
SBOM, raw/policy reports, manifest and checksums are retained under
`dist/release-evidence-review-release-18defa3e`. All **11** selected images have
zero **fixable** HIGH/CRITICAL findings, with an empty exception file. Unfixed
distribution findings remain in raw evidence; this is not a zero-vulnerability
claim. The guest image scan covers OS packages, as documented in the release
policy; it does not replace CI's full language-package scan. Unchanged installer
gateways and third-party infrastructure are outside this matched image set.

Template retention now shares a 30-second I/O budget across release phases and
stops after an unconfirmed deletion. The known old-replica timeout occurred again;
remaining targets were preserved and new registration completed. No target metadata
was deleted to manufacture cleanup success.

## Live acceptance

All model checks use **GPT-6 Luna** and owned disposable resources.

- [Tools](review-release-tools-20261006.json): real write/Bash execution and exact
  file hash; two complete Tool calls and execute checkpoints, with zero Tool-call
  drafts in native documents.
- [Native navigation](review-release-navigation-20261006.json): tree anchors,
  independent Fork, byte-identical canonical Tool results, successful model reuse
  of the earlier test result, and parent-tail/descendant pruning.
- [Subagents](review-release-subagents-20261006.json): supervisor interaction,
  direct messaging, two parallel children, cancellation and guest-boundary checks;
  children share the parent's physical Session and owner.
- [Uploads and recovery](review-release-uploads-20261006.json): the actual browser
  uploads six files totaling 60,862,923 bytes, including a 24,162,763-byte image.
  Luna sees the attachment without a Tool round trip; the image-bearing native
  record is 1,766 bytes. Overwriting the Workspace source and replacing the original
  Worker still lets another Worker recover the retained image and identify a
  previously unreported visual attribute.
- [Compaction](review-release-compaction-20261006.json): real Gateway/Durable/Luna
  compaction and the following model request each receive a grant and retain the
  configured service tier. This uses a 4,096-token component fixture, not a claim
  of production PG/Kafka crash recovery or a capacity benchmark.

The added navigation fixture initially expected pruning to preserve a descendant,
contrary to the existing API contract. That assertion was corrected. Two model
recall checks failed with a random hexadecimal receipt; explicit native-body
comparison proved an exact copy, and the observed reply declined to provide the
receipt. A later generated Bash call failed before the Fork; its detailed output
was not retained. The fixture now captures failed Tool output and supplies an
exact multiline command producing an ordinary numeric test result. The final
complete check passes. These were not resolved by changing production history or
deletion behavior; initial diagnostic artifacts remain in the private release
directory.

The first backup verification waited on stdin through `kubectl exec`; the completed
dump was instead verified from a read-only file mount. One image-collection attempt
preceded completion of the Cubelet build; the final clean-source collection includes
all eleven completed images. Neither incomplete attempt is reported as a pass.

## Final state and limits

Owned test resources were cleaned up. Final checks find no active Runs, unsealed
writers or pending Outbox work; both Worker replicas and the Gateway are ready.
The two historical UNKNOWN runtime records have exactly their original identities
and states. No whole-VM cleanup was inferred from a missing probe.

Old template-replica cleanup still needs diagnosis. Cross-node filesystem failover
and large-scale capacity remain unverified. The earlier deterministic native
recovery and 203-case fault evidence remain distinct from these live smoke checks.
