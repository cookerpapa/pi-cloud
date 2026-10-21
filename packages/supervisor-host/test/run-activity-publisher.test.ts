import { afterEach, expect, it, vi } from "vitest";
import { RunActivityPublisher } from "../src/run-activity-publisher.ts";
import {
  parseRunActivityDelivery,
  EXECUTION_READINESS_PATH,
  type ExecutionObservationDelivery,
} from "@pi-cloud/protocol";
const scope = {
  tenantId: "tenant",
  sessionId: "session",
  turnId: "turn",
  runId: "run",
  writerId: "writer",
  piSessionId: "physical",
  fencingToken: 1,
};
afterEach(() => vi.useRealTimers());

it("coalesces activity and republishes quiet state without inventing actual progress", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const send = vi.fn(async () => new Response(null, { status: 204 }));
  const publisher = new RunActivityPublisher("http://control", "private-token", send);
  try {
    for (let i = 0; i < 1000; i++)
      publisher.update(
        scope,
        0,
        { phase: "receiving_model", lastActivityAt: 90_000 + i },
        { sessionId: "parent", turnId: "parent-turn", toolCallId: "task:10" },
      );
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledOnce();
    const first = parseRunActivityDelivery(JSON.parse((send.mock.calls[0] as any)[1].body));
    expect(first).toMatchObject({ revision: 1, lastActivityAt: 90_999 });
    expect(first.parent).toEqual({
      sessionId: "parent",
      turnId: "parent-turn",
      toolCallId: "task:10",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const second = parseRunActivityDelivery(JSON.parse((send.mock.calls[1] as any)[1].body));
    expect(second).toMatchObject({ revision: 2, lastActivityAt: 90_999 });
    expect(second.observedAt).toBeGreaterThan(first.observedAt);
    publisher.forget(scope.runId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    publisher.close();
  }
});

it("confirms readiness synchronously with one owner redirect and respects Stop", async () => {
  const delivery: ExecutionObservationDelivery = {
    scope,
    partition: 2,
    kind: "probe",
    requestId: "nonce",
    sentAt: 1000,
    evidence: { bindingId: "binding", targetId: "target", bootId: "boot", observedAt: 1001 },
  };
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: `http://owner:3000${EXECUTION_READINESS_PATH}` },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const publisher = new RunActivityPublisher("http://control", "token", send);
  try {
    expect(await publisher.confirmExecution(delivery, new AbortController().signal)).toBe(true);
    expect(send.mock.calls.map(([url]) => String(url))).toEqual([
      `http://control${EXECUTION_READINESS_PATH}`,
      `http://owner:3000${EXECUTION_READINESS_PATH}`,
    ]);
    const stop = new AbortController();
    send.mockImplementationOnce(async () => {
      stop.abort();
      return new Response(null, { status: 204 });
    });
    expect(await publisher.confirmExecution(delivery, stop.signal)).toBe(false);
    expect(await publisher.confirmExecution(delivery, AbortSignal.abort())).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    send.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await publisher.confirmExecution(delivery, new AbortController().signal)).toBe(false);
    expect(send).toHaveBeenCalledTimes(5);
  } finally {
    publisher.close();
  }
});

it("limits in-flight requests, rotates fairness and aborts forgotten or closing Runs", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const send: typeof fetch = vi.fn(async (_url, options) => {
    const signal = options!.signal!;
    signals.push(signal);
    return await new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  });
  const publisher = new RunActivityPublisher("http://control", "token", send);
  for (let n = 0; n < 20; n++)
    publisher.update({ ...scope, runId: String(n) }, 0, {
      phase: "waiting_model",
      lastActivityAt: Date.now(),
    });
  publisher.flush();
  publisher.flush();
  expect(signals).toHaveLength(4);
  publisher.forget("0");
  expect(signals[0]?.aborted).toBe(true);
  publisher.close();
  expect(signals.every((s) => s.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  publisher.flush();
  expect(signals).toHaveLength(4);
});
