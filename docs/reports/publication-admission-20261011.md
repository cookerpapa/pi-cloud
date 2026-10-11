# Publication registration rejection

Date: 2026-10-11. Approved while reading the Worker-to-ingress handoff.
Implementation retains ADR-0209's PG authorization and ordered closure; it changes
neither authority, storage, protocol nor schema 184.
Deployed as `publication-admission-c39a78f8`, source
`c39a78f8d5e4d4755cfa82784b94cf1cc8ccb8ed`.

## Behavior and acceptance

Registration now rejects identities that the partition owner's existing memory
already proves stale or closed before beginning its PG admission read. The shared
check also runs after that read, together with the existing admission ticket that
closure and owner replacement invalidate. No second cache or compatibility path
is introduced.

| Registration | PG queries |
| --- | --- |
| Known closed Run/writer or obsolete/conflicting writer identity | 0 |
| New identity, matching open identity or higher epoch | 1 |
| Memory missing after owner replacement or eviction | 1 |

The table describes ordinary registration, excluding routing and retries.
Unknown state is not permission to open; ordinary append remains SQL-free.
Closed sibling Runs do not block another Lane of the same live writer, and a
closed old incarnation does not reject the PG-authorized successor incarnation.

## Verification

Before implementation, four new rejection cases reached the deliberately
unavailable PG adapter, reproducing the unnecessary database dependency. After
implementation, they reject from memory. Additional cases require PG for current,
new, sibling, successor, restarted and evicted identities.

The RF3/PG HTTP integration test measures registration SQL separately from append
SQL and checks ordinary admission, repeated registration, restart recovery,
known closure, replacement by a newer writer and cold rejection of an old grant.
Existing tests retain seal-drain ordering and delayed-read invalidation.

Repository verification passes on the implementation worktree based on `d8f47947`:

- All 22 workspace typechecks; 1,681 tests across 255 passing files. Nine existing
  gated tests in seven files remain skipped by the ordinary suite.
- 64 operator/helper tests and seven isolated RF3/PG transport tests in six files.
- All [240 fault cases](fault-eval-latest.json), including the five new registration
  cases, plus the dependency vulnerability audit.
- Dependency preparation, formatting/docs, installer, runtime policy, native Cube
  admission/allocation contracts, Helm, observability, image closure and build.

The HTTP integration measures zero SQL for known closed/replaced registrations,
one for initial/repeated/open/cold registration, and zero for ordinary appends.
Restart discards memory and rejects the old grant through one PG read. This is a
query-count result, not a production latency or fleet-capacity benchmark.

The first CI invocation found an overly narrow inferred UUID parameter in the
new test helper. Its explicit string type was corrected; that workspace's
typecheck and all remaining CI gates then passed. Already-passing native Cube
checks were not rerun. Private logs are in
`dist/releases/publication-admission-checks/`.

## Deployment and live acceptance

The maintained prepare/apply procedure verified 11 matched images, drained
writers, confirmed native VM absence and deployed the matching application/Cube
artifacts. Schema 184, guest input protocol 4, Tool Worker protocol 4 and Cube
management protocol 7 are unchanged. The image gate passes with zero fixable
HIGH/CRITICAL findings under the existing policy; raw unfixed findings remain
in the private evidence.

The first preparation was interrupted during a slow Trivy database download.
The same pinned scanner fetched a fresh database from the
[official ECR distribution](https://trivy.dev/docs/dev/configuration/db/) over a
direct connection, then the unchanged source/version passed the maintained
prepare procedure. No scan or freshness check was disabled. The temporary local
Docker build-proxy relay was closed before apply; host proxy configuration was
not changed.

Real GPT-6 Luna acceptance passes:

- Native same-Run input consumption, stable retry identity, editing, ordering,
  promotion and Stop restoration.
- Control Plane process SIGKILL, confirmed exit 137 and restart, while one
  already-started Cube Bash operation finishes. The original Worker completes
  the Run, with exactly one invocation of that test command.

The deployed ingress file hash matches the verified source. Control Plane and
Web return HTTP 200, and both Workers are ready. Final native inventory scans
1/1 nodes and reports zero VMs. There are no remaining owned Sessions, Runs,
projects, Workspaces, active leases, unsealed writers, machines or terminals.
The handoff fixture's metadata was removed only after Workspace byte purge and
physical VM absence were confirmed.

The original 29 tenants/users, 30 model profiles/credential bindings, 29 API
credentials, four password-credential rows and platform settings retain their
pre-release configuration fingerprints. No business-data reset or backup was
performed. Private release and live evidence is in
`dist/releases/publication-admission-c39a78f8/`, with prepare/apply logs beside it.
