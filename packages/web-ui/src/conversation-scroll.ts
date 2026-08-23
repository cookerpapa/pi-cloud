export const CONVERSATION_TAIL_THRESHOLD_PX = 96;

export function isConversationTailVisible(
  metrics: Readonly<{ scrollTop: number; scrollHeight: number; clientHeight: number }>,
  threshold = CONVERSATION_TAIL_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError("Conversation tail threshold must be non-negative");
  }
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}
