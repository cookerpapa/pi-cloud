import { expect, it, vi, beforeEach } from "vitest";
import type { ResourceBackend } from "../src/resource-backend-registry.ts";

const fixture = vi.hoisted(() => ({
  rows: [] as ResourceBackend[],
  read: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../src/resource-backend-registry.ts", async (original) => ({
  ...(await original<typeof import("../src/resource-backend-registry.ts")>()),
  readResourceBackends: async () => {
    fixture.read();
    return fixture.rows;
  },
}));
vi.mock("../src/resource-backend-transport.ts", () => ({
  createResourceBackendTransport: fixture.create,
}));
vi.mock("@pi-cloud/database", () => ({
  PostgresNotificationWake: class {
    generation = 0;
    refresh() {}
    wait(_g: number, _ms: number, signal: AbortSignal) {
      return signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
    }
    async close() {}
  },
}));
import { createExecutionBackendDirectory } from "../src/execution-backend-directory.ts";

function backend(id: string, url: string, revision = 1): ResourceBackend {
  return {
    resource: {
      id,
      name: id,
      location: "owned",
      revision,
      state: "active",
      provider: "boxlite",
      templates: [],
      capabilities: {
        kind: "linux",
        workspace: "independent-volume",
        terminal: true,
        preview: true,
      },
    },
    configuration: {
      compute: { provider: "boxlite", url, nodeId: id, token: "fixture" },
      storage: { url: "http://storage", token: "fixture", poolId: "owned" },
      webProxy: { host: "10.255.255.254", port: 3128, directPrivateCidrs: [] },
      templates: [],
    },
  };
}
const target = (url: string) => ({
  apiUrl: url,
  nodeId: "owned",
  sandboxId: "vm",
  bootId: "original",
});
const options = {
  database: {} as never,
  config: {
    persistentStateKey: Buffer.alloc(32, 3),
    serviceToken: "fixture",
    imageRevision: "guest",
  },
  notificationUrl: "fixture",
};
const transport = () => ({
  client: {
    submitTool: vi.fn(async () => {}),
    cancelTool: vi.fn(async () => {}),
    submitProbe: vi.fn(async () => {}),
    probeExecution: vi.fn(async () => ({})),
  },
  provider: { close: vi.fn(async () => {}), clearExecutionData: vi.fn() },
});
beforeEach(() => {
  fixture.rows = [];
  fixture.read.mockClear();
  fixture.create.mockReset();
});

it("adds a known backend without replacing the existing client or querying PG for each bound Tool", async () => {
  fixture.rows = [backend("first", "http://first:8091")];
  const first = transport(),
    second = transport();
  fixture.create.mockImplementation(async (_db, _config, b) =>
    b.resource.id === "first" ? first : second,
  );
  const directory = await createExecutionBackendDirectory(options);
  try {
    await directory.refresh();
    const reads = fixture.read.mock.calls.length;
    await directory.client.submitTool(target("http://first:8091"), {} as never);
    await directory.client.probeExecution(target("http://first:8091"), "probe");
    expect(fixture.read).toHaveBeenCalledTimes(reads);
    fixture.rows = [...fixture.rows, backend("second", "http://second:8091")];
    // A cold lookup also recovers a missed notification.
    await directory.client.submitTool(target("http://second:8091"), {} as never);
    expect(second.client.submitTool).toHaveBeenCalledOnce();
    expect(first.provider.close).not.toHaveBeenCalled();
    await directory.client.submitTool(target("http://first:8091"), {} as never);
    expect(first.client.submitTool).toHaveBeenCalledTimes(2);
  } finally {
    await directory.close();
  }
  expect(first.provider.close).toHaveBeenCalledOnce();
  expect(second.provider.close).toHaveBeenCalledOnce();
});

it("isolates an unavailable new backend and never redirects an old target after a quiescent endpoint change", async () => {
  fixture.rows = [backend("first", "http://first:8091"), backend("bad", "http://bad:8091")];
  const first = transport(),
    replacement = transport();
  fixture.create.mockImplementation(async (_db, _config, b) => {
    if (b.resource.id === "bad") throw new Error("endpoint unavailable");
    return b.resource.revision === 1 ? first : replacement;
  });
  const directory = await createExecutionBackendDirectory(options);
  try {
    await directory.client.submitTool(target("http://first:8091"), {} as never);
    await expect(
      directory.client.submitTool(target("http://bad:8091"), {} as never),
    ).rejects.toMatchObject({ code: "execution_endpoint_unconfigured" });
    expect(first.provider.close).not.toHaveBeenCalled();
    fixture.rows = [backend("first", "http://replacement:8091", 2)];
    await directory.refresh();
    expect(first.provider.close).toHaveBeenCalledOnce();
    await expect(
      directory.client.submitTool(target("http://first:8091"), {} as never),
    ).rejects.toMatchObject({ code: "execution_endpoint_unconfigured" });
    expect(replacement.client.submitTool).not.toHaveBeenCalled();
    await directory.client.submitTool(target("http://replacement:8091"), {} as never);
    expect(replacement.client.submitTool).toHaveBeenCalledOnce();
  } finally {
    await directory.close();
  }
});
