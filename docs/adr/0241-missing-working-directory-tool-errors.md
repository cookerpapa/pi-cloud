# ADR-0241: Missing working directories are native Tool errors

Status: implemented with targeted source verification, 2026-10-10.
Full source/fault gates and matched live acceptance remain pending.

The owner approved repairing the error classification found during the input
admission walkthrough. PG Workspace admission and its deletion lock remain
unchanged: a platform resource and a directory inside its Volume are different
things. This refines ADR-0227's existing native/error boundary.

## Decision

For a fixed Tool, a missing or non-directory user-selected working directory,
confirmed before its body runs, produces an ordinary native `isError` result in
the guest. Use the existing Tool result envelope and Pi Durable public result
contract. The Cube completion adapter forwards it normally; the Worker Harness
owns canonical settlement and the next model request. Do not translate this
known filesystem failure into an infrastructure `UNKNOWN`.

Classify only the known missing-path errors (`ENOENT`, `ENOTDIR`) or a confirmed
non-directory. Other filesystem failures, invalid initialization, Volume mount
validation, cancellation transport failure and missing replies retain their
infrastructure behavior. The fixed `/workspace` mount is an attachment boundary,
not an ordinary user directory; failure there is not downgraded. Classify in the
guest before execution, never by matching arbitrary Tool output in the adapter.
Keep normal cancellation and late-result handling under native Durable authority.

No directory is created, no alternative cwd is selected, and no VM is destroyed
or replaced to hide the error. A later caller-authorized restoration of the
directory can make a new Tool succeed. There is no automatic command replay,
directory watcher, extra PG query, Kafka control event or new execution authority.
The existing file/shell operation can still fail if a path changes after checking.

This is a bounded repair using the pinned Pi Durable 1.0.0 result API and the
existing fixed guest adapter. No additional infrastructure or protocol field is
needed. Schema 183, guest input 4, Tool Worker 4 and Cube management 7 remain;
guest and application source identities still require a matched drained release.

## Acceptance

- Execute the real guest entrypoint after directory deletion/replacement; retain
  Tool identity and a definite error, with no command side effect or cwd fallback.
- Exercise directory loss after a command has started and subsequent explicit
  restoration. Normal file access and existing cancellation contracts still pass.
- Confirm unexpected filesystem/attachment failures remain infrastructure errors.
- Pass the result through Cube completion and native Harness: canonical Tool error
  survives and the model can reply in the same Run; transport loss still blocks
  further sampling and late replies cannot replace native cancellation.
- Run the maintained source/fault gates and matched rollout, then use GPT-6 Luna
  and a disposable Cube directory to verify continuation, unchanged VM identity,
  physical fixture cleanup and preserved accounts/model/provider configuration.

Implementation, source checks and deployed acceptance are recorded separately.
