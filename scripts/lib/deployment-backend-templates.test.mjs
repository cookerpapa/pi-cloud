import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "../../packages/database/src/index.ts";
import { ResourceBackendRegistry } from "../../packages/sandbox-control/src/resource-backend-registry.ts";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "../../packages/protocol/src/development-environment-profile.ts";
import {
  deploymentTemplateConfiguration,
  reconcileDeploymentBackendTemplates,
} from "./deployment-backend-templates.mjs";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const database = postgres
  ? createDatabase({ connectionString: postgres, maxConnections: 3 })
  : undefined;
const pgIt = it.skipIf(!postgres);
beforeAll(() => (database ? runMigrations(database, "up") : undefined), 60000);
afterAll(() => database?.destroy());
const key = Buffer.alloc(32, 8),
  template = {
    imageRevision: "a".repeat(40),
    agent: { templateId: "new-agent" },
    development: Object.fromEntries(
      DEVELOPMENT_ENVIRONMENT_PROFILES.map((p) => [p.key, { templateId: "new-" + p.key }]),
    ),
  };
const configuration = () => ({
  compute: {
    provider: "cubesandbox",
    apiUrl: "http://cube-api:3000",
    apiKey: "private-fixture",
    proxyNodeIp: "cube-proxy",
    proxyPort: 8080,
    proxyScheme: "http",
    sandboxDomain: "cube.app",
  },
  storage: { url: "http://storage:4500", token: "private-storage", poolId: "owned-pool" },
  webProxy: { host: "10.255.255.254", port: 3128, directPrivateCidrs: [] },
  templates: [
    {
      id: "linux",
      name: "My Linux",
      operatingSystem: "Ubuntu",
      imageRevision: "b".repeat(40),
      elasticTemplateId: "old-agent",
      profiles: {
        starter: "old-starter",
        standard: "old-standard",
        performance: "old-performance",
      },
    },
  ],
});
const capacity = (id) => {
  const p =
    DEVELOPMENT_ENVIRONMENT_PROFILES.find((p) => id === "new-" + p.key) ??
    DEVELOPMENT_ENVIRONMENT_PROFILES[0];
  return { cpuCount: p.cpuCount, memoryMiB: p.memoryMiB, systemDiskGiB: p.systemDiskGiB };
};
async function fixture(state = "active") {
  const registry = new ResourceBackendRegistry({
    database,
    key,
    managementBaseUrl: "http://management:4300",
    verify: async () => "owned-pool",
  });
  const id = randomUUID(),
    input = {
      id,
      name: "Keep name",
      location: "Keep location",
      state,
      computeBilling: "external",
      expectedRevision: 0,
      configuration: {
        ...configuration(),
        compute: { ...configuration().compute, apiUrl: `http://cube-${id}:3000` },
      },
    };
  await registry.put(input);
  const get = async () => (await registry.list()).find((b) => b.resource.id === id);
  const native = { verifyTemplate: vi.fn(async (id) => capacity(id)) };
  return {
    registry,
    input,
    get,
    native,
    run: () =>
      reconcileDeploymentBackendTemplates({
        database,
        key,
        domainId: id,
        template,
        allowedApiOrigins: [input.configuration.compute.apiUrl],
        native,
      }),
  };
}
pgIt.each(["active", "disabled"])(
  "advances only deployment templates and retains %s admission, labels and private configuration",
  async (state) => {
    const f = await fixture(state),
      before = await f.get();
    expect(await f.run()).toMatchObject({ changed: true, revision: 2 });
    const after = await f.get();
    for (const field of ["name", "location", "state", "computeBilling"])
      expect(after.resource[field]).toEqual(before.resource[field]);
    for (const field of ["compute", "storage", "webProxy"])
      expect(after.configuration[field]).toEqual(before.configuration[field]);
    expect(after.configuration.templates[0]).toMatchObject({
      name: "My Linux",
      operatingSystem: "Ubuntu",
      imageRevision: template.imageRevision,
      elasticTemplateId: "new-agent",
    });
    expect(await f.run()).toEqual({ changed: false, revision: 2 });
  },
);
it("rejects foreign endpoints and custom template ownership", () => {
  const b = { configuration: configuration() };
  b.configuration.compute.apiUrl = "http://foreign:3000";
  expect(() => deploymentTemplateConfiguration(b, template, ["http://cube-api:3000"])).toThrow(
    "independently managed",
  );
  b.configuration.compute.apiUrl = "http://cube-api:3000";
  b.configuration.templates.push({ ...b.configuration.templates[0], id: "custom" });
  expect(() => deploymentTemplateConfiguration(b, template, ["http://cube-api:3000"])).toThrow(
    "custom",
  );
});
pgIt("leaves the registered directory unchanged if the new native capacity is wrong", async () => {
  const f = await fixture(),
    before = await f.get();
  f.native.verifyTemplate.mockResolvedValue({ cpuCount: 0, memoryMiB: 0, systemDiskGiB: 0 });
  await expect(f.run()).rejects.toThrow();
  expect(await f.get()).toEqual(before);
});
pgIt(
  "does not overwrite an administrative revision accepted during template verification",
  async () => {
    const f = await fixture();
    let changed = false;
    f.native.verifyTemplate.mockImplementation(async (id) => {
      if (!changed) {
        changed = true;
        await f.registry.put({
          ...f.input,
          configuration: undefined,
          name: "Concurrent edit",
          state: "draining",
          expectedRevision: 1,
        });
      }
      return capacity(id);
    });
    await expect(f.run()).rejects.toThrow("revision changed");
    const after = await f.get();
    expect(after.resource.name).toBe("Concurrent edit");
    expect(after.configuration.templates[0].imageRevision).toBe("b".repeat(40));
  },
);
