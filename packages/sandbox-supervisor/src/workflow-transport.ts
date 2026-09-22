import { WebSocket } from "ws";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  TOOL_WORKFLOW_PATH,
  type NativeToolEnd,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";

export type WorkflowHostCall = (
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
export type WorkflowExecutor = (
  toolCallId: string,
  script: string,
  call: WorkflowHostCall,
  signal?: AbortSignal,
  onUpdate?: (result: AgentToolResult<unknown>) => void,
) => Promise<unknown>;

/** Owner-direct duplex result delivery; guest calls still publish through the Worker WAL. */
export async function readWorkflowResult(input: {
  resultUrl: URL;
  executionReference: string;
  operationId: string;
  activationId: string;
  call: WorkflowHostCall;
  completion: Promise<NativeToolEnd>;
  signal?: AbortSignal;
}): Promise<ToolSandboxOperationResponse> {
  input.signal?.throwIfAborted();
  const url = new URL(input.resultUrl);
  url.pathname = TOOL_WORKFLOW_PATH;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${input.executionReference}` },
    maxPayload: 5 * 1024 * 1024,
  });
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastRequestId = 0;
    const calls = new Map<number, { fingerprint: string; result: Promise<unknown> }>();
    const finish = (error?: Error, result?: ToolSandboxOperationResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      controller.abort();
      socket.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new Error("Workflow interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", (error) => finish(new Error(`workflow_result_unknown: ${error.message}`)));
    socket.on("close", () =>
      finish(new Error("workflow_result_unknown: Workflow connection ended before its result")),
    );
    socket.on("message", (bytes) => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "error") finish(new Error(frame.message));
        else if (frame.type === "call") {
          const fingerprint = JSON.stringify([frame.method, frame.args]);
          let call = calls.get(frame.id);
          if (call && call.fingerprint !== fingerprint)
            throw new Error("Workflow request identity changed");
          if (!call) {
            if (!Number.isSafeInteger(frame.id) || frame.id <= lastRequestId || calls.size >= 64)
              throw new Error("Invalid or excessive workflow request");
            lastRequestId = frame.id;
            call = {
              fingerprint,
              result: Promise.resolve().then(() => input.call(frame.method, frame.args, signal)),
            };
            calls.set(frame.id, call);
          }
          const send = (response: unknown) => {
            if (!settled && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify(response));
          };
          void call.result
            .then(
              (value) => send({ id: frame.id, ok: true, value }),
              (error) =>
                send({
                  id: frame.id,
                  ok: false,
                  error: error instanceof Error ? error.message : "Workflow call failed",
                }),
            )
            .finally(() => calls.delete(frame.id))
            .catch((error) => finish(error));
        } else throw new Error("Unknown workflow frame");
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid workflow frame"));
      }
    });
    void input.completion.then(
      (event) => {
        if (event.isError) {
          finish(
            new Error(
              event.result.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            ),
          );
          return;
        }
        finish(undefined, {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: input.activationId,
          operationId: input.operationId,
          operation: "workflow.exec",
          ok: true,
          value: event.result.details,
        });
      },
      (error: unknown) =>
        finish(error instanceof Error ? error : new Error("Workflow result unavailable")),
    );
  });
}
