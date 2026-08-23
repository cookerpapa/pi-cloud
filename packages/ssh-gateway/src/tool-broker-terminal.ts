import {
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
  parseWorkspaceTerminalServerFrame,
} from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
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
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
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

  const queued: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let ended = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  };
  socket.on("message", (data) => {
    try {
      const frame = parseWorkspaceTerminalServerFrame(JSON.parse(text(data)) as unknown);
      if (frame.type === "workspace_terminal.ready") {
        readyResolve?.();
      } else if (frame.type === "workspace_terminal.output") {
        const chunk = Buffer.from(frame.data, "base64");
        const waiter = waiters.shift();
        if (waiter === undefined) queued.push(chunk);
        else waiter({ done: false, value: chunk });
      } else if (frame.type === "workspace_terminal.error") {
        readyReject?.(new Error(frame.message));
        finish();
      } else if (frame.type === "workspace_terminal.exit") {
        finish();
      }
    } catch (error: unknown) {
      readyReject?.(error instanceof Error ? error : new Error("Terminal protocol failed"));
      finish();
    }
  });
  socket.once("close", finish);
  socket.once("error", (error) => {
    readyReject?.(error);
    finish();
  });
  await ready;
  const send = async (frame: unknown): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Terminal is closed");
    await new Promise<void>((resolve, reject) =>
      socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve())),
    );
  };
  return {
    output: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            const chunk = queued.shift();
            if (chunk !== undefined) return { done: false, value: chunk };
            if (ended) return { done: true, value: undefined };
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    input: (data) =>
      send({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: Buffer.from(data).toString("base64"),
      }),
    resize: (rows, cols) =>
      send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.resize", rows, cols }),
    close: async () => {
      if (socket.readyState === WebSocket.OPEN) {
        await send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.close" }).catch(
          () => undefined,
        );
        socket.close(1_000, "SSH client disconnected");
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
      finish();
    },
  };
}
