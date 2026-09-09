/** Presentation evidence from a snapshot, not synthetic Kafka/stream events. */
export function snapshotTurn(snapshot, turnId) {
  const turn = snapshot.conversation.turns.find((turn) => turn.turnId === turnId);
  if (!turn?.transcript) return undefined;
  const transcript = turn.transcript;
  return {
    turn,
    items: transcript.items,
    text: transcript.items
      .filter((item) => item.kind === "text")
      .map((item) => item.text)
      .join(""),
    tools: transcript.items.filter((item) => item.kind === "tool"),
    throughSequence: transcript.throughSequence,
    terminal:
      transcript.terminalSequence === null
        ? undefined
        : {
            turnId,
            seq: transcript.terminalSequence,
            type: transcript.failure
              ? "turn.failed"
              : transcript.cancellation
                ? "turn.cancelled"
                : "turn.completed",
            payload: transcript.failure ??
              transcript.cancellation ?? { stopReason: transcript.stopReason },
          },
  };
}
