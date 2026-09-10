import { PassThrough } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { openToolBrokerTerminal } from "../src/tool-broker-terminal.ts";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function openServer(connect: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", connect);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return {
    grant: {
      ticketId: crypto.randomUUID(),
      tenantId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      sandboxDomainId: "domain",
      toolBrokerBaseUrl: `http://127.0.0.1:${address.port}`,
    },
    terminalToken: "t".repeat(64),
    rows: 24,
    cols: 80,
    allowInsecureInternalHttp: true,
  };
}
const ready = {
  workspaceTerminalProtocolVersion: 1,
  type: "workspace_terminal.ready",
  terminalId: crypto.randomUUID(),
  pid: 1,
  workspaceRoot: "/home/user",
};

it("rejects a connection closed before terminal readiness instead of hanging forever", async () => {
  const options = await openServer((socket) => socket.once("message", () => socket.close()));
  await expect(openToolBrokerTerminal(options)).rejects.toThrow(/closed|disconnected/);
}, 2000);

it("applies stream backpressure while preserving all terminal output", async () => {
  const data = Buffer.alloc(4096, "x");
  const options = await openServer((socket) =>
    socket.once("message", () => {
      socket.send(JSON.stringify(ready));
      for (let i = 0; i < 100; i++)
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.output",
            data: data.toString("base64"),
          }),
        );
      socket.send(
        JSON.stringify({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.exit" }),
      );
    }),
  );
  const terminal = await openToolBrokerTerminal(options);
  try {
    expect(terminal.output).toBeInstanceOf(PassThrough);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stream = terminal.output as PassThrough;
    expect(stream.readableLength + stream.writableLength).toBeLessThanOrEqual(512 * 1024);
    let bytes = 0;
    for await (const chunk of terminal.output) bytes += chunk.byteLength;
    expect(bytes).toBe(100 * data.byteLength);
  } finally {
    await terminal.close();
  }
});

it("surfaces a broken active terminal as an error, not a successful empty stream", async () => {
  const options = await openServer((socket) =>
    socket.once("message", () => {
      socket.send(JSON.stringify(ready));
      setTimeout(() => socket.terminate(), 20);
    }),
  );
  const terminal = await openToolBrokerTerminal(options);
  try {
    await expect(
      (async () => {
        for await (const _chunk of terminal.output) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/disconnected/);
  } finally {
    await terminal.close();
  }
});
