import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { encodeModelSocketRequest } from "@pi-cloud/protocol";
import { ModelWebSocketGateway } from "../src/model-websocket-gateway.ts";

it.each(["upload", "response", "overlap", "malformed", "blocked-client"] as const)(
  "bounds %s transport and releases connection/upload ownership",
  async (mode) => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(upstream, "listening");
    let forwarded = 0,
      reserved = 0,
      released = 0;
    const owner = new AbortController();
    const observed: boolean[] = [];
    const gateway = new ModelWebSocketGateway(
      () => ({
        upstreamUrl: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        headers: {},
        signal: owner.signal,
        admit: () => {
          forwarded++;
        },
        reserve: (size) => {
          reserved += size;
          let done = false;
          return () => {
            if (!done) {
              done = true;
              reserved -= size;
            }
          };
        },
        observe: (_sampling, timing) => {
          observed.push(Boolean(timing.transportCompleted));
        },
        release: () => {
          released++;
        },
      }),
      500,
      { requestBytes: 512, responseBytes: mode === "blocked-client" ? 16 * 1024 * 1024 : 512 },
    );
    const server = createServer();
    server.on("upgrade", (request, socket, head) => gateway.upgrade(request, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    upstream.on("connection", (peer) => {
      peer.on("error", () => {});
      peer.on("message", () => {
        if (mode === "response")
          for (let i = 0; i < 5; i++)
            peer.send(
              JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(180) }),
            );
        if (mode === "blocked-client")
          for (let i = 0; i < 64; i++)
            peer.send(
              JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(128 * 1024) }),
            );
      });
    });
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("error", () => {});
    try {
      await once(client, "open");
      const closed = once(client, "close");
      if (mode === "blocked-client") client.pause();
      const body = JSON.stringify({
        type: "response.create",
        model: "fixture",
        input: mode === "upload" ? "x".repeat(1024) : [],
      });
      const frame = encodeModelSocketRequest(
        { stepSequence: 1, stepSha256: "a".repeat(64), samplingAttempt: 1 },
        body,
      );
      client.send(mode === "malformed" ? "invalid framing" : frame);
      if (mode === "overlap") client.send(frame);
      if (mode === "blocked-client") {
        await new Promise((r) => setTimeout(r, 50));
        owner.abort();
        client.resume();
      }
      await closed;
      expect(forwarded).toBe(["upload", "malformed"].includes(mode) ? 0 : 1);
      expect(reserved).toBe(0);
      expect(released).toBe(1);
      expect(observed).toEqual(forwarded ? [false] : []);
    } finally {
      client.terminate();
      gateway.close();
      for (const peer of upstream.clients) peer.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
