# ADR-0165 — Message-level display recovery and framed snapshots

Status: implemented and [verified](../reports/review-repair-acceptance-20260909.md).

## Decision

Keep Worker → private Kafka → one Session Projector. PG retains native semantic
history; token fragments never become PG rows. An execution opening is idempotent
by its registered identity and first durable log position, including lost commit
replies. Unconfirmed negative opening state is never cached.

The same PG transaction that projects a reconstructible native message or Tool
intent advances display-event and native-log coverage positions on its Attempt. This is
projection metadata, not another transcript, Worker receipt or per-delta write.
Conversation queries include complete native messages and Tool intents from an
active Run; they do not invent a terminal or claim a proposed Tool has executed.

Projector caches compact unfinished presentation spans rather than retaining
all token event objects for an entire Run. After a semantic commit it discards
covered spans. Failure settlement preserves the remaining uncommitted text; it
must not subtract older canonical text from an already-uncovered suffix. Existing
readers hold immutable snapshots, so cache eviction needs no network-duration lock.

Subscribe and capture the immutable tail before reading primary PG. A PG snapshot
cannot precede an already observed committed coverage position. Compose complete
history and the uncovered tail into one presentation snapshot; only subsequent
live events animate. Logical history windows may load older Turns by identity;
the browser never stores or submits a Kafka recovery cursor.

Replace the single oversized SSE snapshot with begin/part/end framing. Normal
small events remain immediate; large complete events use the same bounded framing.
Receive all parts before applying one value. Disconnect before end discards the
incomplete value and retries the ordinary snapshot request. Slow socket writes
have a finite send deadline and do not pin other viewers or Kafka processing.
Do not pause a partition waiting for a future terminal to free memory.

## Adopt before build

Use standard [SSE framing](https://html.spec.whatwg.org/multipage/server-sent-events.html)
and pinned [json-ext](https://github.com/discoveryjs/json-ext) incremental JSON
encoding/decoding, not a new JSON parser or event broker. The library's chunk
target is not a hard frame limit; bound transport parts separately. Neither
encoder nor decoder needs a second complete snapshot JSON string.

The pinned json-ext 1.1.0 parser's fragment merge needs one preparation fix:
define own properties rather than invoking Object.assign's `__proto__` setter.
The existing dependency-preparation script guards the version/source and applies
the same change to ESM/CJS. Framed Tool tests preserve object and primitive
`__proto__` values without changing prototypes. This is a JSON fidelity fix,
not a new parser or a rejection policy for user data.

## Acceptance and rollout

Verify lost PG replies/rollback, fresh/branch Child detail HTTP reads and tenant
denial, per-message eviction during long Runs, immutable readers, a snapshot over
20 MiB, Unicode/frame boundaries, mid-snapshot disconnect, concurrent completion,
slow sockets and continuing Tool commands. Run the maintained fault manifest in
CI and require actual passed assertions rather than a zero exit code or log text.

Coordinate Web and Projector deployment after draining active Runs; reload open
browser pages. Do not retain a legacy snapshot decoder. Existing native history
and Workspaces remain intact; no migration compatibility runtime is added.
