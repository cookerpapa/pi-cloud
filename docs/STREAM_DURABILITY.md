# Streaming durability and recovery

The current path is Worker → Kafka → one partitioned Session Projector group.
Projector drives PG history, live views and Tool routing. Tool executors do not
read Kafka, and the public SSE proxy never builds a second tail.

## Boundaries

- `A`: PG committed execution admission and publication identity;
- `K`: Kafka durably accepted a record under the configured replication policy;
- `F`: the execution's first-record recovery floor is committed in PG;
- `V`: a browser observed valid output through Projector SSE;
- `P`: complete native state and its PG projection position committed together;
- `T`: authority requested an immutable execution seal in the PG Outbox;
- `C`: Projector committed that seal, interrupted prefix and public terminal;
- `S`: a replacement snapshot contains canonical history plus materialized tail.

```text
V implies A and K and F and validity at that record's position
next Run claim implies C(previous requested seals)
live terminal implies C
post-seal old records cannot affect history, UI or new Tool dispatch
Tool effect requires durable model output, validated intent and command
Tool effect is never inferred from output text or a Kafka ACK
S requires no browser-provided cursor
```

Kafka ACK is persistence, not automatic acceptance. An old Worker may still
append a record after its seal; Projector rejects its application.
Publication scope is recorded once under the current ExecutionReference. Cached
scope/closure checks replace remote per-record authority admission, not the sole PG
authority. Only the exact PG-requested seal is valid. Normal closure affects one
Run/Lane; uncertain shared native-writer failure also fences its sibling Lanes.

## One ordered consumer

Physical Pi Session ID keys data and boundaries to one immutable Kafka partition.
Projector replicas share one consumer group. The per-partition handler checks
scope and closure, applies canonical state, updates the live view and delivers relevant
commands/control notices to exact owner boots. It never waits for a guest Bash
to finish. Different partitions run concurrently.

Native PG state and projection progress are one transaction. The consumer marks
a record handled only after its required work finishes. Fetch position is not
committed processing progress. On restart/rebalance, replay begins no later than
PG's canonical/unsealed-prefix floor and the group's completed delivery position.
This covers PG commit succeeding before Tool routing was acknowledged.
Replayed native appends are idempotent; effect receivers retain operation IDs and
applied log positions. A new executor boot cannot adopt old Tool bindings.

There is no opening marker. First native projection also commits the recovery
floor; a first display/control-only record commits its floor before delivery.
Rollback or a lost PG reply retries that first record without changing its floor.
A seal may be the only record of an admitted execution that produced no output.

Active text fragments stay in Kafka/rebuildable memory, not PG token rows. A later
complete message in another Session cannot move recovery beyond an older unsealed
prefix. At a seal, Projector folds visible partial text into the durable terminal;
the next native writer incorporates it and an interruption marker before
sampling. It does not invent a successful Tool result.

## Snapshot-first browser delivery

The public SSE request has no Last-Event-ID or cursor. Kafka group membership
locates the assigned Projector; another API replica proxies the authenticated
request without consuming Kafka. On ownership loss, existing subscriptions close
and reconnect to an owner whose assigned replay has reached its startup boundary.

The owner subscribes to live events, captures an immutable tail, then reads
primary PG. Message-level event/native coverage commits in the same transaction
as the native semantic append; active Run history can therefore replace covered
spans before the Run ends. The captured tail cannot refer to coverage newer than
the subsequent primary-PG snapshot. No PG transaction spans a network write.

The v2 snapshot is an already-materialized conversation, sent in bounded
begin/part/end frames rather than one giant JSON frame. The browser applies it
only after end, then animates future live deltas. Interrupted partial values are
discarded. Normal small events retain their immediate path; a large complete
event is framed as one atomic presentation value as well.

On committed closure, the same Projector immediately announces the terminal and
releases covered fragments. There is no second Kafka commit notification or
pending-successor buffer waiting for it. Readers already holding snapshots keep
their own references. Slow connections have bounded queues and resnapshot rather
than pin shared buffers indefinitely. Heartbeats reuse the outstanding read.

Pi text can coalesce for 25 ms after an immediate first delta. Producer batching
does not change record identity. Thinking, partial Tool arguments and partial
Tool stdout are not public streams. One durable preparation event makes long
Tool argument generation visible; the complete Tool boundary replaces it.

## Crash matrix

| Failure point | Required outcome |
| --- | --- |
| Worker and control processes die before requesting a seal, storage survives | owner retirement requests the seal after expiry/fencing; replay its prefix and commit closure before a successor; do not resume the old Agent automatically |
| first-record PG commit succeeds, reply lost | replay idempotently with the same first position; do not advance past uncommitted work |
| semantic message PG commit | retire covered live spans, preserve borrowed reader references and uncovered suffix |
| connection lost mid-snapshot | discard only the partial browser value; request a new snapshot without a cursor |
| record not durably accepted by Kafka | not shown; an uncertain native append fails its writer rather than inventing success |
| Kafka accepted the record but the publisher lost its ACK | it may project before the seal; do not infer it was absent or replay the Agent |
| after ACK, before Projector | replay accepted positions; a matching execution identity does not bypass its seal |
| visible partial output, before complete message | rebuild from Kafka; closure saves interrupted text |
| model message before validated intent | no effect admitted for that Tool |
| intent without durable Tool result | that Tool may be UNKNOWN; later unstarted Tools stay unstarted |
| during PG transaction | rollback state and position; re-read the record |
| PG commit succeeds, consumer ACK lost | idempotent replay; never skip unfinished delivery |
| seal request before Kafka append | retry the same seal; next Run stays queued |
| old data before first seal | valid historical input, even if PG already knows closure |
| old data after first seal | no PG, UI or new execution effect |
| seal commit before UI update | replacement snapshot or seal replay restores visibility |
| rebalance during awaited work | invalidate subscriptions and suppress stale live/dispatch continuations |
| command admitted, delivery ACK lost | repeat positioned delivery, not shell execution |
| executor dies | old binding cannot move to a new boot; ambiguous outcome is UNKNOWN |
| result arrives after seal | no cache resurrection or publication into closed history |
| Cube dies | preserve Volume files, not lost processes/memory; Harness reports the reset |

## Retention and trust

These recovery rules assume the required PG/Kafka/Volume bytes survive. Kafka
`acks=all` acknowledges in-sync replication, not per-record physical-disk fsync.
Replicas on one host do not provide independent power-loss protection. A process
kill/restart test is not a whole-host power-cut or disaster-recovery test; seals
cannot recreate missing bytes. See [Kafka's flush policy](https://kafka.apache.org/42/operations/hardware-and-os/#application-vs-os-flush-management).

Automatic Kafka time/size deletion is disabled. A safe reaper uses canonical
progress, the oldest unsealed start and an additional grace period. Missing PG
progress blocks reclamation. A known missing active prefix is an error, not a
reason to quietly continue with older context. Capacity limits remain necessary.

Workers and Projectors are trusted platform code; Cube and browser have no Kafka
access. Use private networks and appropriate producer/consumer ACLs. There are
no record signatures: a compromised trusted producer can impersonate another
recorded execution, which is outside this deployment's threat model. Kafka fencing never retracts
an already-issued Cube request or guarantees exactly-once external side effects.
