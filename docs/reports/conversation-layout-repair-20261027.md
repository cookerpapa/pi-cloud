# Conversation layout stability repair

Status: implemented and verified in source; scoped Web publication/live acceptance
pending. Schema 202, backend protocols and dependency pins remain unchanged.

## Findings and behavior

The owner reported gaps between text and Tools, primarily during Agent output,
which disappeared after a scroll. Read-only sampling of the deployed long
conversations observed transient gaps up to 409 px. A production-component
fixture reproduces persistent gaps/overlap after live-window trimming, as well
as loss of tail following after new output.

The reader previously discarded every measured height whenever any row key
disappeared. This also happens when Tool preparation becomes a real Tool row,
groups change, or the bounded live window trims. Remaining rows reverted to
estimates, and stale positions could survive until another scroll/render.
ResizeObserver was additionally deferred to another animation frame.

The repair retains measurements for keys still in the bounded window and removes
only evicted keys. The existing pinned TanStack React Virtual 3.14.22 adapter owns
the size container and row coordinates through its direct-DOM mode. Resize
measurements update those coordinates without another animation-frame delay;
React range commits remain asynchronous to avoid reentrant ResizeObserver loops.
Newly mounted rows measure their actual height instead of trusting a measurement
from a previous mount or width. A stable scrollbar gutter reduces width changes.

The persistent Turn footer means new text/Tools can appear before an unchanged
last key, outside the library's ordinary append detection. Structural changes now
follow the tail while the reader is in live mode. Real wheel/touch/keyboard reading
gestures interrupt that following; frozen historical pages retain their anchor.
The prefetch distance is independent of the 40 px space for the history control,
so an earlier-page boundary no longer needs an empty viewport-height spacer.

Session changes remount the presentation state. Restoring a bookmark retains its
requested pixel offset until the target row is mounted; it no longer relies on
one animation-frame callback finding that row. Already visible anchors correct
their offset directly instead of first jumping to the row's top.

This follows the existing [TanStack chat contract](https://tanstack.com/virtual/latest/docs/chat)
and the adapter APIs in the locally pinned package. It adds no transcript store,
new scrolling library, lifetime history fetch or execution change. ADR-0278's
four-page reader and bounded live tail remain the storage/presentation boundary.

## Verification

`node scripts/run-history-layout-check.mjs <private-directory>` builds production
React components with generated content. It exercises 17 cases: width changes,
group/details expansion, window trimming, progressive text, Tool transitions,
new output while reading, and Session changes. No extra scroll is used to repair
layout. Assertions require settled gaps/overlap below 4 px, reject mismatches
persisting across 80 ms of frame samples, retain the reading anchor and require
the active stream to remain at its latest edge. Final settled discrepancies are
below 1 px. Intermediate DOM samples are retained as diagnostics; they are not
all claimed to be compositor-painted frames. The old committed implementation
fails this fixture and stops displaying later output in its live case.

The unchanged real-PG/API/SSE/browser composition passes at 8 MiB and 1 GiB:

| Check | Final 1 GiB sample |
| --- | --- |
| Serialized native test data | 1,073,973,615 bytes / 49,845 records |
| Latest history read | 8 SQL statements; 2,525,817 body bytes; about 61 ms |
| Resident reader after 24 page loads | 4 pages; 15 mounted blocks |
| Retained browser heap | 15.5–15.7 MiB |
| Refresh bookmark offset | −4,155 px before and after |
| Delayed image growth | Same visible key and viewport offset |
| 600 later live outputs during historical reading | Same visible key and offset |
| Direct navigation, Tool disclosure remount and streamed export | Passed |

These are single-host generated-history measurements, not a fleet or arbitrary
Markdown latency claim. API/storage behavior was not optimized by this change.
Web typechecks and 213 unit tests pass; the scoped publisher also runs its required
presentation/queue/operator checks and the new geometry fixture before building.

An initial fixture missed the generated CSS asset and was corrected to load and
assert the real stylesheet. Intermediate variants exposed an RO loop and a lost
bookmark offset; their failed evidence is retained. The final implementation
passes without suppressing browser errors or removing the original bookmark,
memory, image or history checks.

Publication uses the maintained Web-only procedure. The explicit operator-file
classification includes the new geometry/live fixture and the previous release's
fixture-only Android/schedule fixes; shared API/protocol/dependency/runtime edits
remain rejected. Relevant private evidence is under
`deploy/production/runtime/release-evidence/history-layout-20261027/`.

Live stream reproduction after publication:

```sh
PI_CLOUD_LIVE_HISTORY_LAYOUT_CHECK=1 node --import tsx scripts/run-live-history-layout-check.mjs /private/live-layout
```

This uses a separate Luna tenant/Session and three short Bash calls, measures the
deployed browser without corrective scrolling, then closes its writer and removes
its owned Workspace through normal physical cleanup. Original conversations are
read-only during visual inspection.
