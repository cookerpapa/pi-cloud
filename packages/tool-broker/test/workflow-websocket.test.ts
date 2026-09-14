import { expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createExecutionReference,
  TOOL_WORKFLOW_PATH,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { ToolBrokerServer, type ToolBrokerBackend } from "../src/tool-broker-server.ts";

it("upgrades the real workflow endpoint and transports a large correlated reply", async () => {
  const activationId = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const lease = createExecutionReference(crypto.randomUUID(), crypto.randomUUID(), 1);
  const payload = "x".repeat(256 * 1024);
  let resolveResult!: (result: ToolSandboxOperationResponse) => void;
  const result = new Promise<ToolSandboxOperationResponse>((resolve) => {
    resolveResult = resolve;
  });
  const server = new ToolBrokerServer({
    host: "127.0.0.1",
    port: 0,
    serviceToken: "x".repeat(48),
    broker: {
      providerId: "test",
      activeCount: 0,
      admittedCount: 0,
      admissionWaitingCount: 0,
      maximumActiveSandboxes: 1,
      cleanPrewarmCount: 0,
      checkHealth: async () => {},
      close: async () => {},
      attachWorkflow: async (
        _a: string,
        _o: string,
        received: string,
        send: (value: unknown) => void,
      ) => {
        expect(received).toBe(lease);
        queueMicrotask(() =>
          send({
            type: "call",
            id: 1,
            method: "run",
            args: { key: "child", task: { task: "test" } },
          }),
        );
        return {
          respond(frame: { id: number; value?: unknown }) {
            expect(frame.id).toBe(1);
            expect(frame.value).toBe(payload);
            resolveResult({
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.operation_result",
              activationId,
              operationId,
              operation: "workflow.exec",
              ok: true,
              value: "done",
            });
          },
          close() {},
        };
      },
    } as unknown as ToolBrokerBackend,
    commands: { checkHealth() {}, waitResult: async () => result },
  });
  const address = await server.listen();
  const url = new URL(TOOL_WORKFLOW_PATH, address);
  url.protocol = "ws:";
  url.search = new URLSearchParams({ activationId, operationId }).toString();
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${lease}` } });
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("unexpected-response", () =>
        reject(new Error("Workflow endpoint failed to upgrade")),
      );
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "call")
          socket.send(JSON.stringify({ id: frame.id, ok: true, value: payload }));
        if (frame.type === "result") resolve(frame.response);
      });
    });
    expect(response).toMatchObject({ operation: "workflow.exec", ok: true, value: "done" });
  } finally {
    socket.terminate();
    await server.close();
  }
});
