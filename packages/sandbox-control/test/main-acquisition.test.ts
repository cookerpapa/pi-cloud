import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  errors: new Map<string, Error>(),
  call(name: string) {
    this.calls.push(name);
    const error = this.errors.get(name);
    if (error) throw error;
  },
}));
vi.mock("../src/sandbox-control-config.ts", () => ({
  loadSandboxControlConfig: async () => ({
    databaseUrl: "unused",
    cubeSandbox: { directPrivateCidrs: [] },
  }),
}));
vi.mock("@pi-cloud/database", () => ({
  PostgresNotificationWake: class {
    async close() {
      fixture.call("cleanup-wake.close");
    }
  },
}));
vi.mock("../src/workspace-runtime-state-repository.ts", () => ({
  PostgresWorkspaceRuntimeStateRepository: class {
    async start() {
      fixture.call("ownership.start");
    }
    async close() {
      fixture.call("ownership.close");
    }
  },
}));
vi.mock("@pi-cloud/observability", () => ({
  operationalLog: vi.fn(),
  startServiceObservability: async () => {
    fixture.call("metrics.start");
    return {
      metrics: {},
      close: async () => {
        fixture.call("metrics.close");
      },
    };
  },
}));
vi.mock("../src/workspace-volume-gateway.ts", () => ({
  HttpWorkspaceVolumeGateway: class {
    async close() {
      fixture.call("volume.close");
    }
  },
}));
vi.mock("../src/cubesandbox-sandbox-provider.ts", () => ({
  CubeSandboxProvider: class {
    constructor(
      private readonly options: {
        workspaceVolumeGateway: { close(): Promise<void> };
        runtimeClient: { close(): Promise<void> };
      },
    ) {}
    async close() {
      fixture.call("provider.close");
      await this.options.workspaceVolumeGateway.close();
      await this.options.runtimeClient.close();
    }
  },
}));
vi.mock("../src/cubesandbox-runtime-client.ts", () => ({
  OfficialCubeSandboxRuntimeClient: class {
    constructor() {
      fixture.call("cube.construct");
    }
    async close() {
      fixture.call("cube.close");
    }
  },
}));
vi.mock("../src/tool-command-dispatcher.ts", () => ({
  ToolCommandDispatcher: class {
    constructor(private readonly options: any) {}
    async close() {
      fixture.call("dispatcher.close");
      await this.options.workflow.close();
    }
  },
  httpToolLogDelivery: () =>
    Object.assign(async () => {}, { close: async () => fixture.call("workflow-client.close") }),
}));
vi.mock("../src/workspace-volume-deletion-reaper.ts", () => ({
  WorkspaceVolumeDeletionReaper: class {
    start() {
      fixture.call("reaper.start");
    }
    async close() {
      fixture.call("reaper.close");
    }
  },
}));
vi.mock("../src/sandbox-http-service-registry.ts", () => ({
  PostgresSandboxHttpServiceRegistry: class {},
}));
vi.mock("../src/sandbox-controller.ts", () => ({
  SandboxController: class {
    constructor(
      private readonly options: {
        provider: { close(): Promise<void> };
        stateRepository: { close(): Promise<void> };
      },
    ) {}
    async recoverPersistentDevelopmentEnvironments() {
      fixture.call("broker.recover");
    }
    async close() {
      fixture.call("broker.close");
      await this.options.provider.close();
      await this.options.stateRepository.close();
    }
  },
}));
vi.mock("../src/workflow-command-dispatcher.ts", () => ({
  WorkflowCommandDispatcher: class {
    async close() {
      fixture.call("commands.close");
    }
  },
}));
vi.mock("@pi-cloud/event-log", () => ({
  ToolProgressPublisher: class {
    async close() {
      fixture.call("progress.close");
    }
  },
  KafkaToolReplyPublisher: class {
    async start() {
      fixture.call("replies.start");
    }
    async close() {
      fixture.call("replies.close");
    }
  },
}));
vi.mock("../src/sandbox-control-server.ts", () => ({
  SandboxControlServer: class {
    constructor(private readonly options: { broker: { close(): Promise<void> } }) {}
    async listen() {
      fixture.call("server.listen");
    }
    async close() {
      fixture.call("server.close");
      await this.options.broker.close();
    }
  },
}));
beforeEach(() => {
  vi.resetModules();
  fixture.calls.length = 0;
  fixture.errors.clear();
});

const database = { destroy: vi.fn() };
async function start() {
  const { createSandboxControl } = await import("../src/sandbox-control-runtime.ts");
  return createSandboxControl({
    database: database as any,
    instanceId: "test-controller",
    managementToken: "m".repeat(64),
    publishBindingChanges: async () => {},
    partitionFor: () => 0,
    partitionCount: 1,
    metrics: {} as any,
  });
}
it("releases acquired resource ownership when native client initialization fails", async () => {
  const failure = new Error("client startup failed");
  fixture.errors.set("cube.construct", failure);
  await expect(start()).rejects.toBe(failure);
  expect(fixture.calls).toEqual(["ownership.start", "cube.construct", "ownership.close"]);
  expect(database.destroy).not.toHaveBeenCalled();
});
it("preserves startup and cleanup errors without closing the shared database", async () => {
  const first = new Error("client failed"),
    second = new Error("ownership close failed");
  fixture.errors.set("cube.construct", first);
  fixture.errors.set("ownership.close", second);
  await expect(start()).rejects.toMatchObject({ errors: [first, second], cause: first });
  expect(database.destroy).not.toHaveBeenCalled();
});
const closed = [
  "reaper.close",
  "dispatcher.close",
  "workflow-client.close",
  "server.close",
  "broker.close",
  "provider.close",
  "volume.close",
  "cube.close",
  "ownership.close",
  "commands.close",
  "progress.close",
  "replies.close",
  "cleanup-wake.close",
];
it("unwinds every owned layer after listener failure", async () => {
  const failure = new Error("listen failed");
  fixture.errors.set("server.listen", failure);
  await expect(start()).rejects.toBe(failure);
  expect(fixture.calls.filter((name) => name.endsWith(".close"))).toEqual(closed);
});
it("joins one shutdown and continues releasing independent resources after errors", async () => {
  const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const runtime = await start();
  const first = new Error("reaper failed"),
    second = new Error("command close failed");
  fixture.errors.set("reaper.close", first);
  fixture.errors.set("commands.close", second);
  const closing = runtime.close();
  expect(runtime.close()).toBe(closing);
  await expect(closing).rejects.toMatchObject({ errors: [first, second], cause: first });
  expect(fixture.calls.filter((name) => name.endsWith(".close"))).toEqual(closed);
  expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
  expect(database.destroy).not.toHaveBeenCalled();
});
