import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEVICE_LINK_MAX_BYTES,
  DEVICE_LINK_WAIT_MS,
  isDeviceRequest,
  unavailable,
  type DeviceResponse,
} from "./frames.ts";

/** Reconnect the transport; never resend an operation after a lost acknowledgement. */
export async function connectDevice(options: {
  url: string;
  deviceToken: string;
  receiverUrl: string;
  receiverToken: string;
  signal: AbortSignal;
  onStatus?(state: "connected" | "disconnected"): void;
  retryMs?: number;
}) {
  const target = new URL(options.url),
    receiver = new URL(options.receiverUrl);
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    !(target.protocol === "wss:" || (target.protocol === "ws:" && loopback.has(target.hostname))) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Use a WSS device endpoint (WS is only allowed on loopback)");
  if (
    receiver.protocol !== "http:" ||
    !loopback.has(receiver.hostname) ||
    receiver.pathname !== "/" ||
    receiver.username ||
    receiver.password ||
    receiver.search ||
    receiver.hash
  )
    throw new Error("The fixed receiver must be a local HTTP origin");
  if (options.deviceToken.length < 32 || options.receiverToken.length < 32)
    throw new Error("Device credentials are missing");
  let attempt = 0;
  while (!options.signal.aborted) {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(target, {
        headers: { authorization: "Bearer " + options.deviceToken },
        maxPayload: DEVICE_LINK_MAX_BYTES,
        handshakeTimeout: 10_000,
      });
      const stop = () => socket.terminate();
      options.signal.addEventListener("abort", stop, { once: true });
      if (options.signal.aborted) stop();
      socket.on("open", () => {
        attempt = 0;
        options.onStatus?.("connected");
      });
      socket.on("error", stop);
      socket.once("close", () => {
        options.signal.removeEventListener("abort", stop);
        options.onStatus?.("disconnected");
        resolve();
      });
      socket.on("message", (bytes) => {
        let call: unknown;
        try {
          call = JSON.parse(bytes.toString());
        } catch {
          socket.close(1008);
          return;
        }
        if (!isDeviceRequest(call)) {
          socket.close(1008);
          return;
        }
        const command = call;
        void (async () => {
          let response: DeviceResponse;
          try {
            const value = await fetch(new URL(command.path, receiver), {
              method: command.method,
              redirect: "error",
              headers: {
                authorization: "Bearer " + options.receiverToken,
                "content-type": "application/json",
              },
              ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
              signal: AbortSignal.timeout(DEVICE_LINK_WAIT_MS),
            });
            // These replies contain admission/status only; actual Tool results use HTTPS completion.
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (value.body)
              for await (const chunk of value.body) {
                size += chunk.byteLength;
                if (size > 65536) throw new Error("Device status too large");
                chunks.push(chunk);
              }
            const text = Buffer.concat(chunks).toString("utf8");
            response = {
              id: command.id,
              status: value.status,
              body: text ? JSON.parse(text) : null,
            };
          } catch {
            response = unavailable(command.id, "unknown");
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
        })().catch(() => socket.terminate());
      });
    });
    if (!options.signal.aborted)
      await delay(
        Math.min(5000, (options.retryMs ?? 300) * 2 ** Math.min(attempt++, 4)),
        undefined,
        { signal: options.signal },
      ).catch(() => {});
  }
}
