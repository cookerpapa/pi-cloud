# Architecture reading checkpoint

Updated: 2026-10-10.

The walkthrough explains one component-to-component hop at a time, including
its message, acknowledgement boundary, failure behavior and design tradeoffs.

Current checkpoint: **Browser → Control Plane → PostgreSQL input acceptance**.
Covered HTTP idempotency keys, accepted versus executed input, atomic intake,
PG queue readiness and the difference between cloud control records and the
native append-only log. Detailed Worker claim/lease admission has not yet been
walked through; that is the next hop.

Follow-up discussions established:

- Core Session/Turn/Run fields are consolidated under ADR-0238.
- A cloud Run can process multiple native human submissions.
- Native follow-up waits for the final boundary; steer uses the earlier native
  boundary. Pi Durable persists pending submissions and InboxDoc changes.
- Pending edits append document changes; they do not rewrite committed history
  or expose superseded drafts to the model.
- Current UI model preference remains control state. Actual native Run model
  configuration is persisted when applied, not for every selector click.
- During a running Run, an unavailable Worker leaves the new draft unconfirmed
  in the browser; success requires native Kafka durability acknowledgement.
- ADR-0240 reuses Session/idempotency reads inside the same locked transaction:
  ordinary initial intake is eight business SQL statements and same-key retry
  is two. Normal authentication plus BEGIN/COMMIT bring initial intake to eleven.
- Ordered Kafka views speed downstream routing/display; mutable PG admission
  decisions still use current authority. This change adds no cross-request cache.
- The Workspace admission SELECT checks the PG resource and keeps its shared
  lock until Run registration commits. It does not stat a directory or probe a VM;
  concurrent deletion and Run intake remain serialized by the existing PG locks.
- Projector's binding view serves ordered Tool routing, with synchronous closure
  and recovery guards; it does not replace new-Run Workspace admission.
- The directory-deletion discussion found a separate guest classification bug.
  ADR-0241 returns known pre-execution user-directory failures as native Tool errors;
  deployment/acceptance is tracked in ROADMAP. No intake SQL changes are required.

Resume with: **how an available Pi Worker selects a ready Run from PG, prevents
another Worker taking the same execution, and obtains the physical-Session lease**.
Explain that hop before continuing into native Session initialization or Kafka.
