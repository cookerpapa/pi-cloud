import { StringDecoder } from "node:string_decoder";
import { createConnection, createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import {
  GUEST_EXECUTOR_MAX_INPUT,
  GUEST_EXECUTOR_MAX_OUTPUT,
  guestUuid,
} from "@pi-cloud/protocol/guest";
export const GUEST_STATE = "/run/pi-cloud-executor";
export const GUEST_SOCKET = GUEST_STATE + "/control.sock";
export const operationInput = (id: string) => {
  if (!guestUuid(id)) throw new Error("invalid_identity");
  return `${GUEST_STATE}/operations/${id}.json`;
};
export const operationSocket = (id: string) => {
  if (!guestUuid(id)) throw new Error("invalid_identity");
  return `${GUEST_STATE}/operations/${id}.sock`;
};
export function processStart(pid: number): string | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8"),
      f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X"].includes(f[0]!) ? undefined : f[19];
  } catch {
    return undefined;
  }
}
export function guestRpc(path: string, body: unknown, timeoutMs = 5000): Promise<any> {
  const bytes = Buffer.from(JSON.stringify(body) + "\n");
  if (bytes.length > GUEST_EXECUTOR_MAX_INPUT) return Promise.reject(new Error("invalid_request"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const decoder = new StringDecoder("utf8");
    let output = "",
      settled = false;
    const end = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeoutMs, () => end(new Error("guest_rpc_timeout")));
    socket.once("connect", () => socket.write(bytes));
    socket.on("error", () => end(new Error("guest_rpc_unavailable")));
    socket.on("data", (chunk) => {
      output += decoder.write(chunk);
      if (Buffer.byteLength(output) > GUEST_EXECUTOR_MAX_OUTPUT)
        return end(new Error("guest_rpc_oversized"));
      const at = output.indexOf("\n");
      if (at >= 0) {
        try {
          end(undefined, JSON.parse(output.slice(0, at)));
        } catch {
          end(new Error("guest_rpc_invalid"));
        }
      }
    });
    socket.once("end", () => end(new Error("guest_rpc_incomplete")));
  });
}
export async function listenGuestRpc(
  path: string,
  handle: (request: any) => Promise<unknown>,
): Promise<Server> {
  const server = createServer((socket) => {
    const decoder = new StringDecoder("utf8");
    let input = "",
      processing = false;
    socket.on("error", () => {});
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (processing) return;
      input += decoder.write(chunk);
      if (Buffer.byteLength(input) > GUEST_EXECUTOR_MAX_INPUT) {
        socket.destroy();
        return;
      }
      const at = input.indexOf("\n");
      if (at < 0) return;
      processing = true;
      let request: unknown;
      try {
        request = JSON.parse(input.slice(0, at));
      } catch {
        socket.end('{"accepted":false,"rejection":"invalid_request"}\n');
        return;
      }
      // A disconnected client never cancels an admitted operation.
      void handle(request)
        .then((value) => {
          const reply = JSON.stringify(value) + "\n";
          if (Buffer.byteLength(reply) > GUEST_EXECUTOR_MAX_OUTPUT)
            throw new Error("reply_oversized");
          socket.end(reply);
        })
        .catch(() => socket.end('{"accepted":false,"rejection":"handoff_unconfirmed"}\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}
