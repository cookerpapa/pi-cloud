import { afterEach, expect, it, vi } from "vitest";
import {
  measureRunPreparation,
  startRunPreparation,
  capturePreparationWork,
  PiCloudMetrics,
} from "../src/index.ts";
import * as logger from "../src/logger.ts";

afterEach(() => vi.restoreAllMocks());

it("correlates a bounded stage without logging its result or labelling metrics by Run", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  vi.spyOn(Date, "now").mockReturnValue(123456);
  vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(25);
  const metrics = new PiCloudMetrics("test");
  const result = { secret: "private-result" };
  expect(await measureRunPreparation("run-a", "writer_prepare", metrics, async () => result)).toBe(
    result,
  );
  expect(log).toHaveBeenCalledWith({
    service: "pi-cloud-worker",
    level: "info",
    event: "run.preparation.timing",
    attributes: {
      runId: "run-a",
      stage: "writer_prepare",
      outcome: "completed",
      startedAtMs: 123456,
      startedMonotonicMs: 10,
      processStartedAtMs: performance.timeOrigin,
      durationMs: 15,
    },
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-result");
  const output = await metrics.registry.metrics();
  expect(output).toContain('stage="writer_prepare",outcome="completed"');
  expect(output).not.toContain("run-a");
});

it("classifies a failed operation but does not export its private exception", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  const failure = new Error("private-query-text");
  await expect(
    measureRunPreparation("run-a", "writer_prepare", undefined, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(log.mock.calls[0]?.[0].attributes?.outcome).toBe("failed");
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-query-text");
});

it("a diagnostic sink cannot change a committed result or replace an operation failure", async () => {
  vi.spyOn(logger, "operationalLog").mockImplementation(() => {
    throw new Error("sink failed");
  });
  await expect(
    measureRunPreparation("run-a", "writer_prepare", undefined, async () => 42),
  ).resolves.toBe(42);
  const failure = new Error("operation failed");
  await expect(
    measureRunPreparation("run-b", "writer_prepare", undefined, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

it("concurrent preparation stages retain their own Run identity", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = measureRunPreparation("run-a", "pi_session_open", undefined, () => pending);
  await measureRunPreparation("run-b", "pi_session_open", undefined, async () => {});
  release();
  await first;
  expect(log.mock.calls.map(([r]) => r.attributes?.runId)).toEqual(["run-b", "run-a"]);
});

it("aggregates nested I/O without extra log lines or cross-Lane state", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  expect(capturePreparationWork("image_read")).toBeUndefined();
  const gate = Promise.withResolvers<void>();
  let late: ReturnType<typeof capturePreparationWork>;
  const first = measureRunPreparation("root", "native_context_prepare", undefined, async () => {
    late = capturePreparationWork("storage_read");
    capturePreparationWork("storage_read")?.({ durationMs: 20, outcome: "completed" });
    capturePreparationWork("image_read")?.({
      durationMs: 12,
      byteLength: 1024,
      outcome: "completed",
    });
    await gate.promise;
    return "private-content";
  });
  await measureRunPreparation("child", "native_context_prepare", undefined, async () => {
    capturePreparationWork("image_read")?.({ durationMs: 3, byteLength: 16, outcome: "failed" });
  });
  gate.resolve();
  await first;
  late?.({ durationMs: 99, outcome: "completed" });
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[0]![0].attributes).toMatchObject({
    runId: "child",
    image_readCount: 1,
    image_readMs: 3,
    imageBytes: 16,
    image_readIncomplete: 1,
  });
  expect(log.mock.calls[1]![0].attributes).toMatchObject({
    runId: "root",
    storage_readCount: 1,
    storage_readMs: 20,
    image_readCount: 1,
    imageBytes: 1024,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-content");
});
it("closes pre-model timing at dispatch, not after the provider response", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  const timer = startRunPreparation("run", "native_request_prepare");
  const response = Promise.withResolvers<void>();
  const executing = timer.run(async () => {
    timer.finish("completed");
    expect(capturePreparationWork("storage_read")).toBeUndefined();
    await response.promise;
  });
  expect(log).toHaveBeenCalledOnce();
  response.resolve();
  await executing;
  expect(log).toHaveBeenCalledOnce();
});
it("records cancellation without replacing the original rejection or logging arbitrary metadata", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  const aborted = new AbortController(),
    error = new Error("private-message");
  await expect(
    measureRunPreparation(
      "run",
      "pi_session_open",
      undefined,
      async () => {
        aborted.abort(error);
        throw error;
      },
      { signal: aborted.signal, details: { conversationId: 2, prompt: "secret-prompt" } as never },
    ),
  ).rejects.toBe(error);
  expect(log.mock.calls[0]![0].attributes).toMatchObject({
    outcome: "cancelled",
    conversationId: 2,
  });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-message|secret-prompt/);
});
