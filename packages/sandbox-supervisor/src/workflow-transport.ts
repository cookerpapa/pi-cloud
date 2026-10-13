import { WebSocket } from "ws";
import { toolTransportFailure } from "./tool-execution-outcome.ts";
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
export type WorkflowPreparer = (
  toolCallId: string,
  script: string,
  call: WorkflowHostCall,
  signal: AbortSignal | undefined,
  nativeToolName: string,
) => Promise<import("./prepared-tool.ts").PreparedToolExecution>;

/** Duplex guest host calls; completion arrives on Kafka, observations bypass Worker. */
export async function readWorkflowResult(input: {
  resultUrl: URL;
  executionReference: string;
  operationId: string;
  activationId: string;
  call: WorkflowHostCall;
  completion: Promise<NativeToolEnd>;
  signal?: AbortSignal;
}): Promise<ToolSandboxOperationResponse> {
  const url = new URL(input.resultUrl);
  url.pathname = TOOL_WORKFLOW_PATH;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = input.signal?.aborted
    ? undefined
    : new WebSocket(url, {
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
      socket?.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const fail = (cause: unknown) => finish(toolTransportFailure(cause, "workflow_result_unknown"));
    // A completion already queued on this tick wins a later cancellation.
    const abort = () => queueMicrotask(() => fail(new Error("Workflow interrupted")));
    signal.addEventListener("abort", abort, { once: true });
    socket?.on("error", fail);
    socket?.on("close", () => fail(new Error("Workflow connection ended before its result")));
    socket?.on("message", (bytes) => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "error") fail(new Error(String(frame.message)));
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
            if (!settled && socket?.readyState === WebSocket.OPEN)
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
            .catch(fail);
        } else throw new Error("Unknown workflow frame");
      } catch (error) {
        fail(error);
      }
    });
    void input.completion
      .then((event) => {
        if (event.isError) {
          finish(undefined, {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation_result",
            activationId: input.activationId,
            operationId: input.operationId,
            operation: "workflow.exec",
            ok: false,
            value: null,
            error: event.result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          });
          return;
        }
        finish(undefined, {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: input.activationId,
          operationId: input.operationId,
          operation: "workflow.exec",
          ok: true,
          value: { ...event.result, isError: event.isError },
        });
      }, fail)
      .catch(fail);
    if (signal.aborted) abort();
  });
}
