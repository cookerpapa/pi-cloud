import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ToolExecutionFailure, type ToolReplyWait } from "@pi-cloud/protocol";
/** Minimal public invocation port for infrastructure Tool unit tests. */
export function nativeToolApi(callId: string): ToolExecutionApi {
  return { callId, taskId: 1, conversationId: 1 } as ToolExecutionApi;
}

/** A test source with no attachment phase; cross-stage tests use the real mailbox. */
export function fixtureToolReply<T>(source: Promise<T>): ToolReplyWait<T> {
  let settled = false;
  const result = source.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = error instanceof ToolExecutionFailure && error.effect === "not_started";
      throw error;
    },
  );
  void result.catch(() => {});
  return { result, executionSettled: () => settled };
}
