# CLIProxyAPI upstream contribution assessment — 2026-11-06

This assessment is separate from PiCloud Issue #4. No new upstream PR, comment or
force-push was made as part of the metering implementation.

The deployed adapter uses fixed v8.0.57 plus the published personal-fork revision
`7baeffb84befe97ad6af1f95249f293251000458`. The original v7 checkout remains intact;
runtime v7 compatibility code was not retained in PiCloud.

## Suitable general contributions

- **Native Responses compatibility providers.** The v8 adaptation preserves opaque
  native input/output, validates the configured wire protocol and refuses missing
  translators. It has protocol/terminal/configuration tests. Existing
  [PR #5382](https://github.com/router-for-me/CLIProxyAPI/pull/5382) was still open
  at the check, with the older v7 head `2d1310af`; the tested v8 adaptation should
  replace that base before requesting a new review.
- **Bounded stream diagnostics and error scope.** Request-scoped truncation and
  cancellation handling, with metadata-only diagnostics, are useful beyond PiCloud.
  Existing [PR #5667](https://github.com/router-for-me/CLIProxyAPI/pull/5667) and
  [PR #5684](https://github.com/router-for-me/CLIProxyAPI/pull/5684) were also open
  at the check. Their upstream overlap and current base should be reviewed before
  republishing changes; not every historical PR is part of the installed fork.
- **Optional synchronous usage capture.** The context-scoped capture port closes
  the handoff gap before the asynchronous usage queue. Reused-connection, fallback,
  cancellation/lifetime and unclean-exit evidence now exists. A small SDK proposal
  can be separated from PiCloud's journal: opt-in capture, immutable copied caller
  context, bounded persistence, and no propagation of accounting failure as a
  retryable model error. It is a contribution candidate, not an accepted upstream
  contract or a native-plugin ABI guarantee.

## Keep in PiCloud

Tenant/Run attribution schemas, private receipt delivery, the PG statement/rate
model, collection policy and UI are application concerns. The provider-local
bbolt adapter and deployment credential/path wiring also remain behind PiCloud's
accounting port. They should not turn CPA core into a tenant wallet or require all
CPA users to deploy PostgreSQL.

The logical cross-HTTP continuation adapter is another possible general feature,
but needs a neutral public API, explicit lifetime/eviction semantics and no
PiCloud-specific identity naming before upstream discussion. The v8-native
WebSocket send-failure handling already replaced our older duplicate guard.
