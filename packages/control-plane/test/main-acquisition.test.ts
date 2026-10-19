import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  config: vi.fn(),
  database: vi.fn(),
  observability: vi.fn(),
  subagents: vi.fn(),
  projector: vi.fn(),
  sandbox: vi.fn(),
  sandboxClose: vi.fn(),
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
vi.mock("@pi-cloud/sandbox-control/runtime", () => ({ createSandboxControl: calls.sandbox }));
import { startControlPlane } from "../src/main.ts";

beforeEach(() => {
  vi.resetAllMocks();
  calls.config.mockResolvedValue({
    databaseUrl: "postgresql://fixture",
    databaseNotificationUrl: "postgresql://direct-fixture",
    supervisorManagementToken: "fixture-management-token".repeat(3),
    sandboxControlBaseUrls: ["http://sandbox-control.test"],
    workspaceServiceToken: "fixture-workspace-token".repeat(3),
    allowInsecureInternalHttp: true,
  });
  calls.sandboxClose.mockResolvedValue(undefined);
  calls.sandbox.mockResolvedValue({ close: calls.sandboxClose, dispatcher: {} });
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
    destroy = vi.fn(async () => {}),
    destroyMaintenance = vi.fn(async () => {}),
    destroyPublication = vi.fn(async () => {}),
    destroyProjection = vi.fn(async () => {});
  const failure = new Error("Subagent construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database
    .mockReturnValueOnce({ destroy })
    .mockReturnValueOnce({ destroy: destroyMaintenance })
    .mockReturnValueOnce({ destroy: destroyPublication })
    .mockReturnValueOnce({ destroy: destroyProjection });
  calls.subagents.mockImplementation(function () {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroyMaintenance).toHaveBeenCalledOnce();
  expect(destroyPublication).toHaveBeenCalledOnce();
  expect(destroyProjection).toHaveBeenCalledOnce();
  expect(calls.database).toHaveBeenNthCalledWith(4, {
    connectionString: "postgresql://direct-fixture",
    maxConnections: 12,
    checkoutTimeoutMs: 30000,
  });
  expect(calls.database).toHaveBeenNthCalledWith(3, {
    connectionString: "postgresql://direct-fixture",
    maxConnections: 4,
    checkoutTimeoutMs: 5000,
  });
  expect(calls.sandbox).toHaveBeenCalledWith(
    expect.objectContaining({ publicationDatabase: { destroy: destroyPublication } }),
  );
  expect(calls.database).toHaveBeenNthCalledWith(2, {
    connectionString: "postgresql://direct-fixture",
    maxConnections: 3,
    checkoutTimeoutMs: 5000,
  });
  expect(close).toHaveBeenCalledOnce();
  expect(calls.sandboxClose).toHaveBeenCalledOnce();
});

it("closes a constructed Subagent controller when Projector ownership was never established", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {}),
    destroyMaintenance = vi.fn(async () => {}),
    destroyPublication = vi.fn(async () => {}),
    destroyProjection = vi.fn(async () => {}),
    destroyReads = vi.fn(async () => {}),
    subagentClose = vi.fn(async () => {});
  const failure = new Error("Projector construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database
    .mockReturnValueOnce({ destroy })
    .mockReturnValueOnce({ destroy: destroyMaintenance })
    .mockReturnValueOnce({ destroy: destroyPublication })
    .mockReturnValueOnce({ destroy: destroyProjection })
    .mockReturnValueOnce({ destroy: destroyReads });
  calls.subagents.mockImplementation(function () {
    return { close: subagentClose };
  });
  calls.projector.mockImplementation(function () {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(subagentClose).toHaveBeenCalledOnce();
  expect(calls.sandboxClose).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroyMaintenance).toHaveBeenCalledOnce();
  expect(destroyPublication).toHaveBeenCalledOnce();
  expect(destroyProjection).toHaveBeenCalledOnce();
  expect(calls.projector).toHaveBeenCalledWith(
    expect.objectContaining({
      database: { destroy: destroyProjection },
      publicationDatabase: { destroy: destroyPublication },
    }),
  );
  expect(destroyReads).toHaveBeenCalledOnce();
  expect(calls.database).toHaveBeenLastCalledWith(
    expect.objectContaining({ maxConnections: 2, readTimeoutMs: 5000 }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it("closes the ordinary pool if maintenance pool construction fails", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {});
  const failure = new Error("Maintenance database construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database.mockReturnValueOnce({ destroy }).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(calls.sandbox).not.toHaveBeenCalled();
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

it("closes earlier pools when the publication pool cannot be constructed", async () => {
  const close = vi.fn(async () => {}),
    destroy = vi.fn(async () => {}),
    destroyMaintenance = vi.fn(async () => {});
  const failure = new Error("Publication database construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  calls.database
    .mockReturnValueOnce({ destroy })
    .mockReturnValueOnce({ destroy: destroyMaintenance })
    .mockImplementationOnce(() => {
      throw failure;
    });
  await expect(startControlPlane()).rejects.toBe(failure);
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroyMaintenance).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(calls.sandbox).not.toHaveBeenCalled();
});

it("closes earlier pools when the projection pool cannot be constructed", async () => {
  const close = vi.fn(async () => {});
  const destroys = Array.from({ length: 3 }, () => vi.fn(async () => {}));
  const failure = new Error("Projection database construction failed");
  calls.observability.mockResolvedValue({ metrics: {}, close });
  for (const destroy of destroys) calls.database.mockReturnValueOnce({ destroy });
  calls.database.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(startControlPlane()).rejects.toBe(failure);
  for (const destroy of destroys) expect(destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(calls.sandbox).not.toHaveBeenCalled();
});
