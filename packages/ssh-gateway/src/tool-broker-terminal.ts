import {
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
  parseWorkspaceTerminalServerFrame,
} from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { PassThrough } from "node:stream";
import type { SshTerminalGrant } from "./ticket-authority.ts";

function websocketUrl(baseUrl: string): string {
  const target = new URL(baseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH;
  target.search = "";
  target.hash = "";
  return target.toString();
}

function text(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

export type ToolBrokerTerminal = Readonly<{
  output: AsyncIterable<Uint8Array>;
  input(data: Uint8Array): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
  close(): Promise<void>;
}>;

export async function openToolBrokerTerminal(options: {
  grant: SshTerminalGrant;
  terminalToken: string;
  rows: number;
  cols: number;
  allowInsecureInternalHttp: boolean;
}): Promise<ToolBrokerTerminal> {
  const url = websocketUrl(options.grant.toolBrokerBaseUrl);
  if (url.startsWith("ws:") && !options.allowInsecureInternalHttp) {
    throw new Error("Insecure Tool Broker terminal route was rejected");
  }
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${options.terminalToken}` },
    maxPayload: MAX_WORKSPACE_TERMINAL_FRAME_BYTES * 2,
    perMessageDeflate: false,
    handshakeTimeout: 30_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Tool Broker closed before connecting")));
  });
  socket.send(
    JSON.stringify({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment_terminal.open",
      requestId: randomUUID(),
      environmentId: options.grant.environmentId,
      tenantId: options.grant.tenantId,
      userId: options.grant.userId,
      rows: options.rows,
      cols: options.cols,
    }),
  );

  const output = new PassThrough({ highWaterMark: 128 * 1024 });
  output.on("drain", () => socket.resume());
  // A protocol failure can arrive before the caller attaches its iterator.
  output.on("error", () => {});
  let ended = false;
  let opened = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finish = (error?: Error): void => {
    if (ended) return;
    ended = true;
    if (!opened) readyReject?.(error ?? new Error("Tool Broker closed before terminal readiness"));
    if (error) output.destroy(error);
    else output.end();
  };
  socket.on("message", (data) => {
    try {
      const frame = parseWorkspaceTerminalServerFrame(JSON.parse(text(data)) as unknown);
      if (frame.type === "workspace_terminal.ready") {
        opened = true;
        readyResolve?.();
      } else if (frame.type === "workspace_terminal.output") {
        const chunk = Buffer.from(frame.data, "base64");
        if (!output.write(chunk)) socket.pause();
      } else if (frame.type === "workspace_terminal.error") {
        finish(new Error(frame.message));
      } else if (frame.type === "workspace_terminal.exit") {
        finish();
      } else if (frame.type === "workspace_terminal.owner_redirect") {
        finish(new Error("Terminal owner changed; reconnect for a fresh route"));
      }
    } catch (error: unknown) {
      finish(error instanceof Error ? error : new Error("Terminal protocol failed"));
    }
  });
  socket.once("close", () => finish(new Error("Tool Broker terminal disconnected")));
  socket.once("error", (error) => {
    finish(error);
  });
  const timer = setTimeout(() => {
    finish(new Error("Tool Broker terminal readiness timed out"));
    socket.terminate();
  }, 30_000);
  timer.unref();
  try {
    await ready;
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const send = async (frame: unknown): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Terminal is closed");
    await new Promise<void>((resolve, reject) =>
      socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve())),
    );
  };
  return {
    output,
    input: (data) =>
      send({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: Buffer.from(data).toString("base64"),
      }),
    resize: (rows, cols) =>
      send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.resize", rows, cols }),
    close: async () => {
      // A paused websocket must resume to finish its closing handshake.
      socket.resume();
      if (socket.readyState === WebSocket.OPEN) {
        await send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.close" }).catch(
          () => undefined,
        );
        socket.close(1_000, "SSH client disconnected");
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
      finish();
      output.destroy();
    },
  };
}
