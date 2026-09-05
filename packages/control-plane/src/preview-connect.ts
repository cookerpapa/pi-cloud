import { Agent, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import {
  PREVIEW_SCOPE_HEADER,
  TOOL_BROKER_SANDBOX_PREVIEW_PATH,
  type SandboxPreviewConnectionRequest,
} from "@pi-cloud/protocol";

/** The application HTTP/WS bytes travel inside a separately authorized CONNECT. */
export function previewConnectionAgent(
  baseUrl: string,
  serviceToken: string,
  scope: SandboxPreviewConnectionRequest,
  allowHttp: boolean,
): Agent {
  const agent = new Agent({ keepAlive: false });
  const open = (address: string, redirects = 0): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const target = new URL(TOOL_BROKER_SANDBOX_PREVIEW_PATH, address);
      if (
        redirects > 3 ||
        (target.protocol !== "https:" && !(target.protocol === "http:" && allowHttp))
      ) {
        reject(new Error("Invalid preview owner endpoint"));
        return;
      }
      const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: "CONNECT",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          [PREVIEW_SCOPE_HEADER]: Buffer.from(JSON.stringify(scope)).toString("base64url"),
        },
      });
      const timeout = setTimeout(
        () => request.destroy(new Error("Preview connection timed out")),
        15_000,
      );
      timeout.unref();
      request.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      request.once("connect", (response, socket, head) => {
        clearTimeout(timeout);
        request.setTimeout(0);
        if (response.statusCode === 307 && response.headers.location) {
          socket.destroy();
          void open(response.headers.location, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error("Preview owner rejected the connection"));
          return;
        }
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once("response", (response) => {
        clearTimeout(timeout);
        response.resume();
        reject(new Error("Preview CONNECT failed"));
      });
      request.end();
    });
  agent.createConnection = (_options, callback) => {
    void open(baseUrl).then(
      (socket) => callback!(null, socket),
      (error) => callback!(error, undefined as unknown as Socket),
    );
    return undefined as unknown as Socket;
  };
  return agent;
}
