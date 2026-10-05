import type { ToolExecutionApi } from "@earendil-works/pi-durable";
/** Minimal public invocation port for infrastructure Tool unit tests. */
export function nativeToolApi(callId: string): ToolExecutionApi {
  return { callId, taskId: 1, conversationId: 1 } as ToolExecutionApi;
}
