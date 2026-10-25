import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ControlPlaneQuiescence } from "../src/control-plane-quiescence.ts";
import { SessionPublicationService } from "../src/session-publication-service.ts";
import { installBinaryBodyParser } from "../src/binary-body-parser.ts";

afterEach(() => vi.useRealTimers());

it("keeps projection running through reply settlement, then holds the next record before its effects", async () => {
  const tools = { active: 1, unsettled: 1 };
  const gate = new ControlPlaneQuiescence("instance", () => tools);
  expect(gate.prepare("release").phase).toBe("waiting");
  tools.active = 0; // Kafka reply ACK alone is insufficient.
  expect(gate.status().phase).toBe("waiting");
  const settlement = Promise.withResolvers<void>();
  const running = gate.run(async () => {
    tools.unsettled = 0;
    await settlement.promise;
  });
  expect(gate.status().phase).toBe("waiting");
  settlement.resolve();
  await running;
  expect(gate.status().phase).toBe("held");
  const effect = vi.fn(async () => "done");
  const parked = gate.run(effect);
  await Promise.resolve();
  expect(effect).not.toHaveBeenCalled();
  gate.cancel("different release");
  expect(gate.held).toBe(true);
  gate.cancel("release");
  expect(await parked).toBe("done");
  gate.close();
});

it("expires an abandoned hold and rejects another operator without extending execution authority", async () => {
  vi.useFakeTimers();
  const gate = new ControlPlaneQuiescence("instance", () => ({ active: 0, unsettled: 0 }), 30_000);
  gate.prepare("one");
  expect(() => gate.prepare("two")).toThrow("Another replacement");
  const resumed = vi.fn(async () => true),
    work = gate.run(resumed);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(resumed).not.toHaveBeenCalled();
  gate.prepare("one");
  await vi.advanceTimersByTimeAsync(29_000);
  expect(resumed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(await work).toBe(true);
  expect(gate.status().phase).toBe("open");
  gate.close();
});

it("rejects parked projection on shutdown instead of acknowledging unprocessed data", async () => {
  const gate = new ControlPlaneQuiescence("instance", () => ({ active: 0, unsettled: 0 }));
  gate.prepare("release");
  const effect = vi.fn(async () => {}),
    waiting = gate.run(effect);
  gate.close();
  await expect(waiting).rejects.toThrow("stopped");
  expect(effect).not.toHaveBeenCalled();
  expect(() => gate.prepare("again")).toThrow("closing");
});

it("rechecks actual termination after a planning hold expires", async () => {
  vi.useFakeTimers();
  const tools = { active: 0, unsettled: 0 };
  const gate = new ControlPlaneQuiescence("instance", () => tools);
  gate.prepare("release");
  await vi.advanceTimersByTimeAsync(30_001);
  tools.active = 1;
  tools.unsettled = 1;
  let ready = false;
  const shutdown = gate.beforeShutdown().then(() => {
    ready = true;
  });
  gate.cancel("process-stop");
  await vi.advanceTimersByTimeAsync(30_001);
  expect(ready).toBe(false);
  tools.active = 0;
  tools.unsettled = 0;
  await vi.advanceTimersByTimeAsync(30);
  await shutdown;
  expect(gate.held).toBe(true);
  gate.close();
});

it("exposes an authenticated, idempotent and bounded management operation on the existing listener", async () => {
  const gate = new ControlPlaneQuiescence("instance", () => ({ active: 0, unsettled: 0 }));
  const server = Fastify();
  installBinaryBodyParser(server);
  const service = new SessionPublicationService(
    "test-secret",
    {} as ConstructorParameters<typeof SessionPublicationService>[1],
    gate,
  );
  service.install(server);
  const url = "/internal/v1/session-publication/replacement";
  const headers = { authorization: "Bearer test-secret", "content-type": "application/json" };
  const id = "10000000-0000-4000-8000-000000000001";
  try {
    expect((await server.inject({ url })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "POST", url, headers, payload: { id, action: "wrong" } }))
        .statusCode,
    ).toBe(400);
    const body = { id, action: "prepare" };
    for (let i = 0; i < 2; i++)
      expect(
        (await server.inject({ method: "POST", url, headers, payload: body })).json(),
      ).toMatchObject({ phase: "held", requestId: id, instanceId: "instance", version: 1 });
    expect(
      (
        await server.inject({
          method: "POST",
          url,
          headers,
          payload: { ...body, id: "20000000-0000-4000-8000-000000000001" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({ method: "POST", url, headers, payload: { id, action: "cancel" } })
      ).json().phase,
    ).toBe("open");
  } finally {
    gate.close();
    await server.close();
  }
});
