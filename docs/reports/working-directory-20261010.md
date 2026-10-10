# Missing working-directory Tool errors

`working-directory-889279b2` is deployed on October 10, 2026. Runtime repair:
`f1b3feed`; matched release source and required security pins: `889279b2`.
Decision: [ADR-0241](../adr/0241-missing-working-directory-tool-errors.md).
Schema 183, guest input 4, Tool Worker 4 and Cube management 7 remain unchanged.

## Behavior

Previously, deleting a selected working directory before the next fixed Tool
caused guest preparation to emit `worker.failed`. Completion classified it as
UNKNOWN and the Worker refused the next model request, even though the command
had never started.

The guest now recognizes only missing/non-directory paths before execution and
returns the existing native `isError` Tool result. Cube forwards that result;
Pi Harness persists it and can continue the dialogue. Unexpected filesystem,
Volume attachment, cancellation-transport and lost-reply failures retain their
infrastructure handling. The fixed `/workspace` mount is not downgraded. No
directory is created, cwd changed, command replayed or VM replaced automatically.
Run intake still has its eight business SQL statements and Workspace shared lock.

## Source verification

- The actual guest entrypoint reproduced both old failures before the fix.
- 22 workspace typechecks and 1,668 workspace tests pass: 254 passing files;
  seven existing gated files / nine tests skipped.
- All 235 deterministic fault cases pass in 72 groups, including eight new cases.
- Seven isolated RF3 Kafka/PG integration tests pass in six files.
- All 64 release helper tests pass in 15 files. The first helper invocation
  inherited the operator's private `umask 077`, changing temporary fixture file
  modes relative to Git archive. Re-running helpers with the normal checkout
  umask passed without changing product code or weakening provenance checks.
- Formatting, documentation, dependency hardening, installer, policy, Helm,
  observability, image closure, application build and dependency audit pass.
- Native Cube admission/allocation contracts pass again after updating Go pins.

The runtime gates cover directory deletion/replacement, absence of command
effects, no implicit recreation, survival of an already running command, explicit
restoration, completion identity and native Harness continuation. Existing
cancellation, late-reply and UNKNOWN refusal contracts remain passing.

## Matched release and security gate

The first candidate failed the existing zero-fixable-HIGH/CRITICAL image gate.
It contained Go 1.26.6 and older x/net versions affected by recently published
[HTTP/2](https://pkg.go.dev/vuln/GO-2026-6611),
[HTTP Range](https://pkg.go.dev/vuln/GO-2026-6609) and
[TLS](https://pkg.go.dev/vuln/GO-2026-6607) vulnerabilities.

Builders now pin Go 1.26.9 by digest; native Cube, Caddy, CLIProxyAPI and envd
select x/net 0.60.0 with its required dependencies. Cube's existing security
patch and checksums were regenerated against its pinned source. All eleven
matched images pass the unchanged fixable-severity gate. Unfixed findings remain
in private evidence; no scanner exception was added.

The maintained release drained writers and confirmed empty native inventory
before installing the matched Cube, Guest templates and applications. There was
no business-data reset or database schema conversion. A stale build-host Docker
proxy endpoint needed a temporary loopback relay; it was removed after building,
before cutover/live acceptance. No host service configuration or runtime proxy
setting was changed.

## Live acceptance

GPT-6 Luna completed three Runs / six model requests on an owned development
machine. First it removed its selected empty directory, received a definite
error from the next Bash, and answered in that same Run. The second command left
no side effect; the directory was not recreated. A later tool-free chat completed
while the directory was absent. After explicit API restoration, another Run
executed successfully in that directory. The VM identity/state stayed unchanged.

Native follow-up/steer, editing, promotion, retry identity and Stop restoration
also pass. Browser lost-response/Stop/image-return/resend and direct vision pass.
ASCII and Unicode oversized Read results retain 51,200 and 51,196 content bytes
respectively, valid UTF-8 and canonical continuation diagnostics.

The first browser attempt timed out during the Read Run. Provider access logs
show one Responses request lasting about 3m54s until test cancellation; this
does not establish why it stalled. Its owned resources were cleaned. An unchanged
repeat passed all browser/Read checks. Both attempts remain in private evidence;
the timeout is not reported as a repaired provider issue.

This slice did not repeat the broader coding/preview/cold-VM production suite or
test physical-host failure. It verifies the changed Tool boundary, native input,
browser/image/Read paths and the rebuilt services on the installed single host.

## Preservation and completion

All owned Sessions, Runs, Workspaces, projects, images and accounts were removed
after confirmed physical cleanup. Final inventory covers 1/1 nodes with zero
VMs; no active Run, writer, unsealed Session, machine or terminal remains.
Original configuration fingerprints match: 29 users/tenants, 30 model profiles
and credential bindings, 29 API credentials, four password credential rows and
the platform settings are preserved. Web/admin/Control Plane return HTTP 200,
and both Workers are ready on the matching release.

[Bounded evidence](working-directory-20261010.json) records the result without
transcripts or credentials. Private artifacts are under
`dist/releases/working-directory-889279b2/` and
`dist/releases/working-directory-checks/`.
