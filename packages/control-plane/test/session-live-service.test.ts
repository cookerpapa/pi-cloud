import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { SessionEventStream } from "@pi-cloud/runtime-core/session-event-stream";
import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import { SessionLiveService } from "../src/session-live-service.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const session = "00000000-0000-4000-8000-000000000002";
const path = `/internal/v1/session-events/${tenant}/${session}`;
const token = "a".repeat(48);

describe("private execution live stream", () => {
  it("does not expose a tenant stream to browser credentials or an unknown caller", async () => {
    const server = Fastify();
    const owner = vi.fn();
    new SessionLiveService({
      database: {} as Kysely<Database>,
      token,
      stream: { owner } as unknown as SessionEventStream,
    }).install(server);
    try {
      expect(
        (await server.inject({ url: path, headers: { cookie: "pi_cloud_session=browser" } }))
          .statusCode,
      ).toBe(401);
      expect(owner).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("redirects to the projection owner without replacing the requested tenant/session", async () => {
    const server = Fastify();
    const owner = vi.fn(async () => "http://execution-owner:3000");
    new SessionLiveService({
      database: {} as Kysely<Database>,
      token,
      stream: { owner } as unknown as SessionEventStream,
    }).install(server);
    try {
      const response = await server.inject({
        url: path,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(307);
      expect(response.headers.location).toBe(`http://execution-owner:3000${path}`);
      expect(owner).toHaveBeenCalledWith(tenant, session);
    } finally {
      await server.close();
    }
  });

  it("uses the internal credential rather than forwarding browser tokens", () => {
    const stream = new SessionEventStream(
      {
        snapshot: () => {
          throw new Error("remote only");
        },
      },
      new SessionEventHub(),
      { remote: { baseUrl: "http://session-runtime:3000", token } },
    );
    const target = stream.remoteTarget(tenant, session)!;
    expect(target.url.toString()).toBe(`http://session-runtime:3000${path}`);
    expect(target.headers).toEqual({ authorization: `Bearer ${token}` });
  });
});
