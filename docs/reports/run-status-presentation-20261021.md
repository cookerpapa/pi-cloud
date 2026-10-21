# Run status presentation — 2026-10-21

Deployed Web release `run-status-53e61060`, source
`53e61060799c15920f47e8fa19c0d9edc2028958`, platform Helm revision 70.
Web image ID: `sha256:65faa875ec921cefb3ea57ce245134bf599b8163cf374b28f27c9696c2d5e726`.

Active turns show their current phase. Disconnection and stale-update warnings
remain visible. Activity age, message-path confirmation and sandbox round-trip
confirmation move into native HTML diagnostic details, closed by default. Opening
the details reveals the existing observations; it does not trigger another probe.
Heartbeat transport, freshness thresholds, native history and runtime authority
are unchanged. Existing browser pages need a refresh to load the new assets.

## Verification

- Web type checking and 185 tests across Web and component-release contracts pass.
- Real-browser presentation checks cover default hiding, disclosure, fresh and
  stale observations, disconnection/reconnect, cancellation, queue display and
  execution-generation replacement. The first local Web run exposed an obsolete
  server-render assertion for hardcoded models; it now checks loading state,
  while the existing browser fixture verifies API-supplied model choices.
- The scoped operator builds/scans one Web image. Image provenance and the
  zero-fixable-HIGH/CRITICAL gate pass. Render comparison permits only the Web
  Deployment image change; post-apply preflight recognizes the applied candidate.
- Actual GPT-6 Luna/Cube browser acceptance passes: an initial chat, then a silent
  35-second Bash invocation. Confirmation ages stay hidden until diagnostics are
  opened; the guest round trip is visible there, and the Tool/Run completes.
- Original account/model/credential fingerprints, the existing development
  machine's identity/state and all 27 other live Pods/containers are unchanged.
  The other ten component artifact records, catalog and runtime contracts are
  retained. No Worker drain, migration hook or Cube replacement runs.
- The browser fixture deletes its conversations and Workspace through the API.
  Its temporary account/configuration is removed only after confirmed physical
  Workspace purge. Final fingerprints match the pre-release baseline. Linux and
  Windows localhost access both return HTTP 200.

The [ADR-0267 Web amendment](../adr/0267-scoped-releases-and-model-catalog.md)
extends the existing operator to presentation-only changes; API client, protocol,
dependency, proxy and chart edits still require matched preparation. Hosted CI
retains its conservative full classification for Web changes. No claim of a
seamless in-flight browser connection is made; existing SSE recovery owns reconnect.

Private image evidence is under
`deploy/production/runtime/releases/run-status-53e61060/evidence/`.
Source, deployment, browser, preservation and cleanup records are under
`deploy/production/runtime/release-evidence/run-status-20261021/`; no credentials,
transcripts or screenshots are committed.
