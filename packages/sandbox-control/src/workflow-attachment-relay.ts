import { WebSocket } from "ws";
import { TOOL_WORKFLOW_PATH, type WorkflowFrame } from "./workflow-channels.ts";

/** One bounded duplex relay to the current Projector owner; no command admission or replay. */
export async function relayWorkflowAttachment(options: {
  baseUrl: string;
  activationId: string;
  operationId: string;
  executionReference: string;
  send(frame: WorkflowFrame): void;
  signal: AbortSignal;
}) {
  const url = new URL(TOOL_WORKFLOW_PATH, options.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("activationId", options.activationId);
  url.searchParams.set("operationId", options.operationId);
  url.searchParams.set("local", "1");
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${options.executionReference}` },
    maxPayload: 5 * 1024 * 1024,
    handshakeTimeout: 5000,
  });
  const abort = () => socket.terminate();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  socket.once("close", () => {
    options.signal.removeEventListener("abort", abort);
    if (!options.signal.aborted)
      options.send({
        type: "error",
        message: "Workflow owner channel closed",
      } as unknown as WorkflowFrame);
  });
  socket.on("error", () => {});
  socket.on("message", (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString());
      if (frame.type !== "call") throw new Error("Workflow relay closed");
      options.send(frame);
    } catch {
      socket.close(1011, "Workflow relay failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Workflow relay closed before attachment")));
  });
  return {
    respond(frame: { id: number; ok: boolean; value?: unknown; error?: string }) {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024)
        throw new Error("Workflow relay is unavailable");
      socket.send(JSON.stringify(frame));
    },
    close() {
      socket.close();
    },
  };
}
