import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  config: vi.fn(),
  database: vi.fn(),
  observability: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("@pi-cloud/database", () => ({ createDatabase: calls.database }));
vi.mock("@pi-cloud/observability", () => ({ startServiceObservability: calls.observability }));
vi.mock("../src/config.ts", () => ({ loadSupervisorHostConfig: calls.config }));
vi.mock("../src/runtime.ts", () => ({ PiWorkerRuntime: calls.runtime }));
import { startSupervisorHost } from "../src/main.ts";

beforeEach(() => {
  vi.resetAllMocks();
  calls.config.mockResolvedValue({
    databaseUrl: "postgresql://fixture",
    databaseMaxConnections: 2,
  });
});
afterEach(() => vi.restoreAllMocks());

it("drains in dependency order and removes its process listeners", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const order: string[] = [];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  calls.observability.mockResolvedValue({
    metrics: {},
    close: async () => {
      order.push("metrics");
    },
  });
  calls.database.mockReturnValue({
    destroy: async () => {
      order.push("database");
    },
  });
  calls.runtime.mockImplementation(function () {
    return {
      identity: { supervisorId: "fixture", bootId: "fixture", sandboxId: "fixture" },
      start: async () => {},
      waitUntilTerminal: async () => "owner_stopped",
      close: async () => {
        order.push("runtime");
      },
    };
  });
  await startSupervisorHost();
  expect(order).toEqual(["runtime", "metrics", "database"]);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

it("closes observability if database construction throws", async () => {
  const close = vi.fn(async () => {});
  const failure = new Error("Database constructor failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockImplementation(() => {
    throw failure;
  });
  await expect(startSupervisorHost()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
  expect(calls.runtime).not.toHaveBeenCalled();
});

it("closes acquired resources if the runtime constructor throws", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {});
  const failure = new Error("Runtime constructor failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockReturnValue({ destroy });
  calls.runtime.mockImplementation(function () {
    throw failure;
  });
  await expect(startSupervisorHost()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("attempts every cleanup once and preserves startup and cleanup errors", async () => {
  const startup = new Error("Startup failed"),
    runtimeFailure = new Error("Runtime cleanup failed"),
    metricsFailure = new Error("Metrics cleanup failed");
  const destroy = vi.fn(async () => {}),
    runtimeClose = vi.fn(async () => {
      throw runtimeFailure;
    }),
    metricsClose = vi.fn(async () => {
      throw metricsFailure;
    });
  calls.observability.mockResolvedValue({ metrics: {}, close: metricsClose });
  calls.database.mockReturnValue({ destroy });
  calls.runtime.mockImplementation(function () {
    return {
      start: async () => {
        throw startup;
      },
      close: runtimeClose,
    };
  });
  await expect(startSupervisorHost()).rejects.toMatchObject({
    errors: [startup, runtimeFailure, metricsFailure],
  });
  expect(runtimeClose).toHaveBeenCalledTimes(1);
  expect(metricsClose).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
});
