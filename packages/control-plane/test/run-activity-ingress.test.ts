import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  RUN_ACTIVITY_PATH,
  EXECUTION_OBSERVATION_PATH,
  EXECUTION_READINESS_PATH,
} from "@pi-cloud/protocol";
import { RunActivityIngress } from "../src/run-activity-ingress.ts";

it("requires Worker management authority, validates bounded payloads and follows partition ownership", async () => {
  const server = Fastify(),
    owner = vi.fn(async (_p: number): Promise<string | undefined> => undefined),
    publish = vi.fn();
  new RunActivityIngress("worker-token", owner, publish).install(server);
  const payload = {
    scope: {
      tenantId: "t",
      sessionId: "s",
      turnId: "turn",
      runId: "run",
      writerId: "writer",
      piSessionId: "physical",
      fencingToken: 1,
    },
    partition: 2,
    phase: "waiting_model",
    revision: 1,
    observedAt: Date.now(),
    lastActivityAt: Date.now() - 1000,
  };
  const request = {
    method: "POST" as const,
    url: RUN_ACTIVITY_PATH,
    payload,
    headers: { authorization: "Bearer worker-token" },
  };
  try {
    expect((await server.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect(owner).not.toHaveBeenCalled();
    expect(
      (await server.inject({ ...request, payload: { ...payload, reasoning: "PRIVATE" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await server.inject({ ...request, payload: { ...payload, phase: "invented" } })).statusCode,
    ).toBe(400);
    expect((await server.inject(request)).statusCode).toBe(204);
    expect(publish).toHaveBeenCalledExactlyOnceWith(payload);
    owner.mockResolvedValueOnce("http://other:3000");
    const redirect = await server.inject(request);
    expect(redirect.statusCode).toBe(307);
    expect(redirect.headers.location).toBe(`http://other:3000${RUN_ACTIVITY_PATH}`);
    owner.mockRejectedValueOnce(new Error("Owner changed"));
    expect((await server.inject(request)).statusCode).toBe(503);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    await server.close();
  }
});

it("confirms fault readiness only from the current owner and a validated probe", async () => {
  const server = Fastify(),
    owner = vi.fn(async (): Promise<string | undefined> => undefined);
  const ready = vi.fn(async () => false),
    observe = vi.fn();
  new RunActivityIngress("worker-token", owner, vi.fn(), observe, ready).install(server);
  const payload = {
    scope: {
      tenantId: "t",
      sessionId: "s",
      turnId: "turn",
      runId: "run",
      writerId: "w",
      piSessionId: "p",
      fencingToken: 1,
    },
    partition: 0,
    kind: "probe",
    requestId: "probe",
    sentAt: 1000,
    evidence: { bindingId: "binding", targetId: "vm", bootId: "boot", observedAt: 1001 },
  };
  const request = {
    method: "POST" as const,
    url: EXECUTION_READINESS_PATH,
    payload,
    headers: { authorization: "Bearer worker-token" },
  };
  try {
    expect((await server.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect(
      (await server.inject({ ...request, payload: { ...payload, command: "PRIVATE" } })).statusCode,
    ).toBe(400);
    expect(
      (await server.inject({ ...request, payload: { ...payload, kind: "tool" } })).statusCode,
    ).toBe(409);
    expect(ready).not.toHaveBeenCalled();
    expect((await server.inject(request)).statusCode).toBe(409);
    ready.mockResolvedValueOnce(true);
    expect((await server.inject(request)).statusCode).toBe(204);
    owner.mockResolvedValueOnce("http://new-owner:3000");
    const redirected = await server.inject(request);
    expect(redirected.statusCode).toBe(307);
    expect(redirected.headers.location).toBe(`http://new-owner:3000${EXECUTION_READINESS_PATH}`);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(observe).not.toHaveBeenCalled();
    ready.mockRejectedValueOnce(new Error("owner lost"));
    expect((await server.inject(request)).statusCode).toBe(503);
  } finally {
    await server.close();
  }
});

it("routes execution evidence to the same partition owner and rejects extra payload material", async () => {
  const server = Fastify(),
    owner = vi.fn(async (_p: number): Promise<string | undefined> => undefined),
    execution = vi.fn();
  new RunActivityIngress("worker-token", owner, vi.fn(), execution).install(server);
  const payload = {
    scope: {
      tenantId: "t",
      sessionId: "s",
      turnId: "turn",
      runId: "run",
      writerId: "writer",
      piSessionId: "physical",
      fencingToken: 1,
    },
    partition: 2,
    kind: "probe",
    requestId: "probe",
    sentAt: 100000,
    evidence: { bindingId: "binding", targetId: "vm", bootId: "boot", observedAt: 100001 },
    roundTripMs: 1,
  };
  const request = {
    method: "POST" as const,
    url: EXECUTION_OBSERVATION_PATH,
    payload,
    headers: { authorization: "Bearer worker-token" },
  };
  try {
    expect((await server.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect(
      (await server.inject({ ...request, payload: { ...payload, command: "PRIVATE" } })).statusCode,
    ).toBe(400);
    owner.mockResolvedValueOnce("http://other:3000");
    const redirect = await server.inject(request);
    expect(redirect.statusCode).toBe(307);
    expect(execution).not.toHaveBeenCalled();
    expect((await server.inject(request)).statusCode).toBe(204);
    expect(execution).toHaveBeenCalledExactlyOnceWith(payload);
  } finally {
    await server.close();
  }
});
