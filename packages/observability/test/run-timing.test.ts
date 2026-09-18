import { afterEach, expect, it, vi } from "vitest";
import { measureRunPreparation, PiCloudMetrics } from "../src/index.ts";
import * as logger from "../src/logger.ts";

afterEach(() => vi.restoreAllMocks());

it("correlates a bounded stage without logging its result or labelling metrics by Run", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  vi.spyOn(Date, "now").mockReturnValue(123456);
  vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(25);
  const metrics = new PiCloudMetrics("test");
  const result = { secret: "private-result" };
  expect(await measureRunPreparation("run-a", "log_open", metrics, async () => result)).toBe(
    result,
  );
  expect(log).toHaveBeenCalledWith({
    service: "pi-cloud-worker",
    level: "info",
    event: "run.preparation.timing",
    attributes: {
      runId: "run-a",
      stage: "log_open",
      outcome: "completed",
      startedAtMs: 123456,
      durationMs: 15,
    },
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-result");
  const output = await metrics.registry.metrics();
  expect(output).toContain('stage="log_open",outcome="completed"');
  expect(output).not.toContain("run-a");
});

it("classifies a failed operation but does not export its private exception", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  const failure = new Error("private-query-text");
  await expect(
    measureRunPreparation("run-a", "durable_started", undefined, async () => {
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
  await expect(measureRunPreparation("run-a", "log_open", undefined, async () => 42)).resolves.toBe(
    42,
  );
  const failure = new Error("operation failed");
  await expect(
    measureRunPreparation("run-b", "log_open", undefined, async () => {
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
