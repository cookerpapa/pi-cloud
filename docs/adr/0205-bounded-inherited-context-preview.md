# ADR-0205: bounded inherited context preview

Status: accepted for implementation, 2026-10-01 (R30-04 repair).

The delegated conversation detail is a read-only preview, not the owner of model
context. Its previous lifetime ancestor scan ignored native Compaction and
rejected the entire response after 10,000 message Entries.

Walk the child's frozen context anchor backwards for at most 65 Entry rows,
stopping at the first native Compaction. Display its summary separately and
include its native retainedTail messages before the later suffix. Keep at most
64 recent preview messages; cap each text/summary at 32,768 UTF-16 code units and
the combined preview text at 131,072. Truncation preserves Unicode boundaries
and is explicit in the response, UI and export. No Tool execution or model
context is reconstructed from this preview.

The public detail retains inheritedMessages and adds optional
inheritedContextSummary and inheritedMessagesTruncated=true when applicable.
A retained-tail message references its actual Compaction Entry plus messageIndex;
do not invent a native Entry ID for an anonymous retained message. The UI uses
that pair as display identity. Ordinary uncompressed Entries retain their IDs.

The full native log, Worker restoration, child branch anchor and human Fork
pagination are unchanged. No historical body table or per-Step projection
receipt is introduced. API/Web updates ship together; no old unbounded reader
or compatibility branch remains.

Acceptance covers compacted histories above 10,000 messages, retained tails,
uncompacted long histories, bounded/Unicode-safe text, an empty child Turn list,
public schema validation and visible summary/truncation in browser state/export.
