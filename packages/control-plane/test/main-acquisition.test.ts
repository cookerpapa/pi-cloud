import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  config: vi.fn(),
  database: vi.fn(),
  observability: vi.fn(),
  subagents: vi.fn(),
  projector: vi.fn(),
}));
vi.mock("@pi-cloud/database", async (original) => ({
  ...(await original<typeof import("@pi-cloud/database")>()),
  createDatabase: calls.database,
}));
vi.mock("@pi-cloud/observability", async (original) => ({
  ...(await original<typeof import("@pi-cloud/observability")>()),
  startServiceObservability: calls.observability,
}));
vi.mock("../src/production-config.ts", () => ({ loadProductionControlPlaneConfig: calls.config }));
vi.mock("../src/subagent-controller.ts", () => ({ SubagentController: calls.subagents }));
vi.mock("@pi-cloud/runtime-core/session-projector", () => ({ SessionProjector: calls.projector }));
import { startControlPlane } from "../src/main.ts";

beforeEach(() => {
  vi.resetAllMocks();
  calls.config.mockResolvedValue({
    databaseUrl: "postgresql://fixture",
    databaseNotificationUrl: "postgresql://direct-fixture",
    toolDispatchToken: "fixture-dispatch-token".repeat(3),
    toolBrokerBaseUrls: ["http://tool-broker.test"],
    workspaceServiceToken: "fixture-workspace-token".repeat(3),
    allowInsecureInternalHttp: true,
  });
});
afterEach(() => vi.restoreAllMocks());

it("closes the acquired metrics listener if database construction fails", async () => {
  const server = createServer((_request, response) => response.end("fixture"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = vi.fn(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const failure = new Error("Database construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockImplementation(() => {
    throw failure;
  });
  try {
    await expect(startControlPlane()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  } finally {
    if (server.listening) await close();
  }
});

it("cleans database and telemetry when Subagent construction fails before the Projector", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {});
  const failure = new Error("Subagent construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockReturnValue({ destroy });
  calls.subagents.mockImplementation(function () {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("closes a constructed Subagent controller when Projector ownership was never established", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {}),
    subagentClose = vi.fn(async () => {});
  const failure = new Error("Projector construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockReturnValue({ destroy });
  calls.subagents.mockImplementation(function () {
    return { close: subagentClose };
  });
  calls.projector.mockImplementation(function () {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(subagentClose).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("preserves an early primary failure as well as cleanup failures", async () => {
  const failure = new Error("Database construction failed"),
    cleanup = new Error("Telemetry close failed");
  calls.observability.mockResolvedValue({
    metrics: {},
    close: async () => {
      throw cleanup;
    },
  });
  calls.database.mockImplementation(() => {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toMatchObject({
    cause: failure,
    errors: [failure, expect.objectContaining({ errors: [cleanup] })],
  });
});
