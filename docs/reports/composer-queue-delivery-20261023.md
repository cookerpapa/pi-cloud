# Composer and pending queue — 2026-10-23

Web release `composer-4c31ccfc`, source
`4c31ccfc3a780f853e7db8f2ec0cd3c3e7b42060`, is deployed at platform Helm revision 94.
Its image ID is `sha256:63ab29cb3efe8771ffd636158ca37bda41e538e5b4a0cd99da93180f902dd3aa`.
The existing resource-intent runtime, schema 198, native Pi 1.0.0, API and Kafka
contracts remain unchanged. Reload an existing browser page to load the new UI.

## Behavior

- Enter defaults to follow-up. The account menu can select steer while an Agent
  is running. The preference is local to this browser, scoped by tenant/user,
  shared across conversations and retained on reload. Changing it does not edit
  previously accepted inputs; unavailable local storage does not prevent sending.
- One primary button sends when text or attachments are present, using the same
  choice as Enter. An empty active composer shows Stop. Empty Enter does nothing;
  Shift+Enter inserts a newline; IME confirmation never sends. Escape inside the
  composer requests Stop while preserving the draft. Menus and inline queue
  editors handle their own Escape.
- The queue shares the composer surface. It initially displays three compact
  rows, with expansion and pagination for all inputs. This is a display choice,
  not a queue quota. Image thumbnails and file chips replace full attachment cards
  in queued rows. Each row exposes Steer and a menu for edit, remove and movement.
- Editing happens in the row without replacing the composer draft. A concurrent
  consumption or page revision change retains the edit for recovery. The existing
  revision guards, same-key lost-reply retry and Stop-return reconciliation remain.
  A promoted steer stays visible until native consumption removes it.
- Persistent queue instructions and the stale steer-success banner are removed.
  Native Pi still consumes steer after the current Tool round or final boundary;
  follow-up is consumed at the native final boundary. No model interruption,
  background Bash manager or second queue is added.

## Verification and deployment

Web type checking and 196 tests across 28 files pass. Real-browser checks exercise
Enter/button parity, empty Enter, Shift+Enter, IME/repeated keys, Escape, account
isolation, preference persistence/fallback, attachment-only sending, lost replies,
inline edits, optimistic conflicts, ordering, cancellation, steer consumption,
45-input pagination and multi-page Stop return with a lost acknowledgement.

The previously stale queue browser fixture now validates current protocol
resources (`inputId` and string revisions). The live driver checks native inputs
inside one Run instead of the removed one-Run-per-follow-up design. Maintained
browser drivers use the new composer/chip selectors. The Web gate includes the
queue browser check and explicitly permits these acceptance-only script changes;
API clients, runtime dependencies, protocol, proxy and chart changes still fail
narrow-release classification. `AGENTS.md` is treated as collaboration documentation.

The scoped operator builds/scans one image; image provenance and zero
HIGH/CRITICAL findings pass. Only the Web Deployment image changes. All 28 other
Pod identities/container restart counts, 11 other component records, catalog and
runtime contracts are retained. No migration, Worker drain or VM retirement runs.

Real GPT-6 Luna/Cube acceptance passes on the deployed page. Enter submits native
follow-up, other-client inputs arrive through SSE, reload restores the queue
without polling, and inline edit/move/remove/promotion produces the expected
consumption order inside one Run. A second real Bash Run is stopped with a draft
present; the unconsumed follow-up returns after that draft, and native settlement
reports cancellation. Both Runs used the same unchanged Worker process.

The acceptance conversation and Workspace were deleted through product APIs;
writer closure and physical storage purge were confirmed before removing the
owned temporary tenant. Final preservation matches all 15 protected PG table
snapshots, 33 original Workspace file hashes and 27 credential-file hashes.
The original dedicated machine keeps the same allocation/generation, and no
unfinished Run or extra acceptance tenant/history remains. These are bounded
presentation/queue checks, not a new backend crash-recovery or fleet-capacity claim.

Private evidence is under
`deploy/production/runtime/release-evidence/composer-20261023/`; image evidence is
under `deploy/production/runtime/releases/composer-4c31ccfc/evidence/`. No user
transcripts, image bytes or credentials are committed.
