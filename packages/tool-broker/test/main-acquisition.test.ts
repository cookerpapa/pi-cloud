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
vi.mock("../src/tool-broker-config.ts", () => ({
  loadToolBrokerConfig: async () => ({
    databaseUrl: "unused",
    cubeSandbox: { directPrivateCidrs: [] },
  }),
}));
vi.mock("@pi-cloud/database", () => ({
  createDatabase: () => ({
    destroy: async () => {
      fixture.call("database.close");
    },
  }),
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
    constructor(private readonly options: { workspaceVolumeGateway: { close(): Promise<void> } }) {}
    async close() {
      fixture.call("provider.close");
      await this.options.workspaceVolumeGateway.close();
    }
  },
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
vi.mock("../src/tool-broker.ts", () => ({
  ToolBroker: class {
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
vi.mock("../src/tool-command-executor.ts", () => ({
  ToolCommandExecutor: class {
    async close() {
      fixture.call("commands.close");
    }
  },
}));
vi.mock("@pi-cloud/event-log", () => ({
  KafkaToolReplyPublisher: class {
    async start() {
      fixture.call("replies.start");
    }
    async close() {
      fixture.call("replies.close");
    }
  },
}));
vi.mock("../src/tool-broker-server.ts", () => ({
  ToolBrokerServer: class {
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

it("releases acquired ownership and database after metrics startup fails", async () => {
  const failure = new Error("metrics startup failed");
  fixture.errors.set("metrics.start", failure);
  const { startToolBroker } = await import("../src/main.ts");
  await expect(startToolBroker()).rejects.toBe(failure);
  expect(fixture.calls).toEqual([
    "ownership.start",
    "metrics.start",
    "ownership.close",
    "database.close",
  ]);
});

it("preserves startup failure when partial cleanup fails as well", async () => {
  const first = new Error("metrics failed"),
    second = new Error("database close failed");
  fixture.errors.set("metrics.start", first);
  fixture.errors.set("database.close", second);
  const { startToolBroker } = await import("../src/main.ts");
  await expect(startToolBroker()).rejects.toMatchObject({ errors: [first, second], cause: first });
});

const closed = [
  "reaper.close",
  "commands.close",
  "server.close",
  "broker.close",
  "provider.close",
  "volume.close",
  "ownership.close",
  "replies.close",
  "database.close",
  "metrics.close",
];

it("unwinds all acquired layers if the listener cannot start", async () => {
  const failure = new Error("listen failed");
  fixture.errors.set("server.listen", failure);
  const { startToolBroker } = await import("../src/main.ts");
  await expect(startToolBroker()).rejects.toBe(failure);
  expect(fixture.calls.filter((name) => name.endsWith(".close"))).toEqual(closed);
});

it("continues shutdown after earlier failures, closes once and removes signal listeners", async () => {
  const first = new Error("reaper failed"),
    second = new Error("command close failed");
  const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const { startToolBroker } = await import("../src/main.ts");
  const runtime = await startToolBroker();
  fixture.errors.set("reaper.close", first);
  fixture.errors.set("commands.close", second);
  const closing = runtime.close();
  expect(runtime.close()).toBe(closing);
  await expect(closing).rejects.toMatchObject({ errors: [first, second], cause: first });
  expect(fixture.calls.filter((name) => name.endsWith(".close"))).toEqual(closed);
  expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
});
