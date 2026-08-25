import {
  PI_SESSION_MUTATION_INGEST_PATH,
  PiSessionMutationIngestError,
} from "@pi-cloud/runtime-core/jetstream-pi-session-mutations";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { PiSessionMutationIngestGateway } from "../src/pi-session-mutation-ingest-gateway.ts";

const TOKEN = "m".repeat(48);

describe("PiSessionMutationIngestGateway", () => {
  it("authenticates Workers and returns only durable acceptance", async () => {
    const ingest = vi.fn(async () => ({ mutationId: "mutation-1", accepted: true as const }));
    const server = Fastify({ logger: false });
    new PiSessionMutationIngestGateway({
      ingestor: { ingest, checkHealth: async () => undefined },
      serviceToken: TOKEN,
    }).install(server);
    const unauthorized = await server.inject({
      method: "POST",
      url: PI_SESSION_MUTATION_INGEST_PATH,
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(401);
    const accepted = await server.inject({
      method: "POST",
      url: PI_SESSION_MUTATION_INGEST_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { mutationId: "mutation-1" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ mutationId: "mutation-1", accepted: true });
    expect(ingest).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("maps stale authority to conflict without publishing a success", async () => {
    const server = Fastify({ logger: false });
    new PiSessionMutationIngestGateway({
      ingestor: {
        ingest: async () => {
          throw new PiSessionMutationIngestError("stale_execution_grant", "stale", false);
        },
        checkHealth: async () => undefined,
      },
      serviceToken: TOKEN,
    }).install(server);
    const response = await server.inject({
      method: "POST",
      url: PI_SESSION_MUTATION_INGEST_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "stale_execution_grant" });
    await server.close();
  });
});
