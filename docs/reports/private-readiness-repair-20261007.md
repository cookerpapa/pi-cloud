# Private-use readiness repairs

The owner approved D07-01–04 from the
[architecture evidence review](architecture-evidence-review-20261007.md).
This change retains Pi/PG/Kafka/Projector/Cube authority and changes operator
tooling, tests and documentation. It does not start the private pilot or deploy
a new runtime. The owner subsequently declined backups of current disposable
data; no production backup, schedule or remote destination was created.

## Implemented behavior

- **D07-01:** `run-matched-release.mjs` prepares app/native/guest artifacts and
  scans them before draining. The candidate image catalog is separate from the
  serving catalog. Read-only preflight verifies source/input identity, checksums,
  scanned image IDs and the exact registered guest digest when reusing a template.
  Registration uses the prepared image without rebuilding after scanning.
  Git archive verification now reproduces source modes independently of caller
  umask while retaining executable/mode checks. Trivy download can use the host
  proxy; scans remain offline with the existing security gate.
- The formerly private browser Stop/returned-image/Read driver is maintained in
  source. Its cleanup waits for physical Workspace purge and removes only its
  newly created tenant/images. Native provider acceptance now has an audited,
  revision-checked nullable-proxy restore, a private crash-recovery receipt and
  an explicit restore command. Concurrent administrator edits are preserved.
- **D07-02:** ADR-0161/0209/0219 explicitly defer superseded clauses to the current
  Durable Storage, logical-Run recovery and native abort/ordered cancellation
  contracts. ARCHITECTURE provides one concise current-contract table.
- **D07-03:** the [pilot](../PRIVATE_PILOT.md) now has a bounded task sample,
  outcome/intervention criteria, evidence fields and stop conditions. No usage
  outcomes or fleet performance are inferred from infrastructure tests.
- **D07-04:** optional [cold asset recovery](../ASSET_RECOVERY.md) uses official
  pinned PG dump/restore and the existing S3 adapter. Source quiescence and one
  snapshot bind history to referenced immutable images. Empty-target restoration
  clears old grants, control queues, transport positions and Cube bindings in
  the same SQL transaction, retains exact native bytes, and assigns new Workspaces.
  An explicit final COMMIT prevents early input EOF from committing unsanitized
  state. This is not a second native history or runtime storage backend.

## Evidence

- The full operator-helper suite passes **60 tests in 15 files**. Subsequent
  asset/preflight changes were rechecked in their affected suites. Contracts cover
  restrictive umask, substituted images/catalogs, exact reused-guest identity,
  failed preflight without Kubernetes mutation, proxy restoration/failure/concurrent
  edits, and owned cleanup refusing an unpurged Workspace.
- The seven-case recovery drill uses an owned PG instance and **two independent
  SeaweedFS containers**, all at production pins. It backs up synthetic text,
  Tool output (including NUL/lone-surrogate strings), Compaction and an image;
  destroys the source database/object server; compares exact native log bytes;
  hydrates the original image; and proves that only a fresh request gets a new
  Run/lease against the new Workspace. A real FK failure after pg_restore proves
  complete SQL rollback. Active writers, unprojected seals, corrupted/missing
  bytes, schema mismatch and nonempty targets are rejected.
- The maintained real browser driver passed against
  `pi-cloud/control-plane:review-release-49e9b8cc`, using **GPT-6 Luna**.
  Lost admission reply → Stop → returned text/image → fresh key/Run/direct vision
  passed. Four owned Runs comprised two cancellations and two completions.
  Read returned 51,200 bytes from a 120,017-byte ASCII source and 51,196 bytes
  from a 140,031-byte UTF-8 source, with intact encoding and canonical continuation
  diagnostics. The owned account, one image object, Session and physically purged
  Workspace were removed. The Control Plane remained ready on the same image.
  Driver SHA-256: `528cfc26044df440c2651b952d02a5de442803fb1e458fb536cd2e0ce600907e`.
  Bounded private evidence: `dist/readiness-live-acceptance-20261007.json`.
- Documentation links, installer contract/shell syntax, runtime budget/template
  retention policy, image closure, formatting and diff checks pass.

## Scope and remaining claims

The new coordinated `apply` entry point has not performed another production
cutover in this task. Its constituent deployed build/Helm/deploy tools are reused;
preflight and fixture boundaries are newly tested. The running app/guest/native
protocols and data are unchanged apart from disposable acceptance fixtures.

The recovery drill proves the bounded storage contract with a small synthetic
dataset, not whole-machine failure, fleet HA, large-history RTO or a fresh-host
installation. New-Run admission uses a controlled execution backend; it is not
a paid post-restore Luna/Cube run. No off-machine backup currently protects the
owner's disposable data. R07R3-04 remains owner-deferred. Actual pilot results and
the separately listed fleet/fresh-machine/whole-deployment gates remain open.
