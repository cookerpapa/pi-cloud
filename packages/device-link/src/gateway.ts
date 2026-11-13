import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import {
  DEVICE_LINK_MAX_BYTES,
  DEVICE_LINK_WAIT_MS,
  deviceId,
  isDeviceRequest,
  isDeviceResponse,
  unavailable,
  type DeviceResponse,
} from "./frames.ts";

function authorized(actual: string | undefined, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const a = Buffer.from(actual ?? ""),
    b = Buffer.from("Bearer " + token);
  return a.length === b.length && timingSafeEqual(a, b);
}
type Peer = {
  socket: WebSocket;
  pending: Map<string, (value: DeviceResponse) => void>;
  bytes: number;
};

/** Disposable transport only. No Tool replay, command queue, Session or lifecycle ownership. */
export async function createDeviceGateway(options: {
  managementToken: string;
  deviceToken(targetId: string): string | undefined | Promise<string | undefined>;
  waitMs?: number;
}) {
  const server = Fastify({
    logger: false,
    bodyLimit: DEVICE_LINK_MAX_BYTES,
    requestTimeout: 10_000,
  });
  const peers = new Map<string, Peer>();
  let pendingBytes = 0;
  await server.register(websocket, { options: { maxPayload: DEVICE_LINK_MAX_BYTES } });
  server.get("/health/live", async () => ({ alive: true }));
  server.get<{ Params: { targetId: string } }>(
    "/v1/device-links/:targetId",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (
          !deviceId.test(request.params.targetId) ||
          !authorized(
            request.headers.authorization,
            await options.deviceToken(request.params.targetId),
          )
        )
          return reply.code(401).send();
      },
    },
    (socket, request) => {
      const target = request.params.targetId;
      if (peers.has(target)) {
        socket.close(1008, "Device already connected");
        return;
      }
      const peer: Peer = { socket, pending: new Map(), bytes: 0 };
      peers.set(target, peer);
      const close = () => {
        if (peers.get(target) === peer) peers.delete(target);
        for (const [id, settle] of peer.pending) settle(unavailable(id, "unknown"));
        peer.pending.clear();
      };
      socket.on("error", () => socket.terminate());
      socket.once("close", close);
      socket.on("message", (bytes) => {
        try {
          const value: unknown = JSON.parse(bytes.toString());
          if (!isDeviceResponse(value)) throw Error("Invalid response");
          peer.pending.get(value.id)?.(value);
        } catch {
          socket.close(1008, "Invalid device response");
        }
      });
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const timer = setInterval(() => {
        if (!alive) socket.terminate();
        else {
          alive = false;
          socket.ping();
        }
      }, 15_000);
      timer.unref();
      socket.once("close", () => clearInterval(timer));
    },
  );
  server.all<{ Params: { targetId: string; "*": string } }>(
    "/targets/:targetId/*",
    async (request, reply) => {
      if (!authorized(request.headers.authorization, options.managementToken))
        return reply.code(401).send();
      const id = randomUUID();
      const call = {
        id,
        method: request.method,
        path: "/" + request.params["*"],
        ...(request.body === undefined ? {} : { body: request.body }),
      };
      if (!deviceId.test(request.params.targetId) || !isDeviceRequest(call))
        return reply.code(404).send();
      const peer = peers.get(request.params.targetId);
      const encoded = JSON.stringify(call),
        bytes = Buffer.byteLength(encoded);
      if (
        !peer ||
        peer.socket.readyState !== 1 ||
        peer.pending.size >= 64 ||
        peer.bytes + bytes > 8 * 1024 * 1024 ||
        pendingBytes + bytes > 16 * 1024 * 1024
      ) {
        const failure = unavailable(id, "not_started");
        return reply.code(failure.status).send(failure.body);
      }
      const response = await new Promise<DeviceResponse>((resolve) => {
        let settled = false;
        peer.bytes += bytes;
        pendingBytes += bytes;
        const settle = (value: DeviceResponse) => {
          if (settled) return;
          settled = true;
          peer.bytes -= bytes;
          pendingBytes -= bytes;
          clearTimeout(timer);
          peer.pending.delete(id);
          resolve(value);
        };
        const timer = setTimeout(
          () => settle(unavailable(id, "unknown")),
          options.waitMs ?? DEVICE_LINK_WAIT_MS,
        );
        peer.pending.set(id, settle);
        peer.socket.send(encoded, (error) => {
          if (error) settle(unavailable(id, "unknown"));
        });
      });
      return reply.code(response.status).send(response.body);
    },
  );
  server.addHook("onClose", async () => {
    for (const peer of peers.values()) peer.socket.terminate();
  });
  return server;
}
