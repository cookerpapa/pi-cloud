import { expect, it } from "vitest";
import {
  boxliteTemplatePublication,
  boxliteVerificationConfiguration,
  configurationIdentity,
} from "./boxlite-backend-maintenance.mjs";
import { parsePutResourceBackend } from "../../packages/protocol/src/resource-backend.ts";
const configuration = () => ({
  compute: {
    provider: "boxlite",
    url: "http://pi-cloud-boxlite:8091",
    nodeId: "owned",
    token: "private",
  },
  storage: {
    url: "http://workspace-volume-gateway:4500",
    token: "private-storage",
    poolId: "pool",
  },
  webProxy: { host: "127.0.0.1", port: 3128, directPrivateCidrs: [] },
  templates: [
    {
      id: "linux",
      name: "Linux",
      operatingSystem: "Linux",
      imageRevision: "old",
      elasticTemplateId: "agent",
      profiles: { starter: "starter", standard: "standard", performance: "performance" },
    },
  ],
});
it.each(["active", "disabled"])(
  "publishes the new BoxLite Guest with original %s admission and replayable revision",
  (state) => {
    const config = configuration(),
      entry = {
        resource: {
          id: "owned-backend",
          name: "Keep",
          location: "Local",
          state,
          computeBilling: "external",
        },
        drainedRevision: 3,
        configurationIdentity: configurationIdentity(config),
      };
    const current = {
      resource: { ...entry.resource, state: "draining", revision: 3 },
      configuration: config,
    };
    const first = boxliteTemplatePublication(entry, current, "new", "owned");
    expect(parsePutResourceBackend(first)).toBeTruthy();
    expect(first.state).toBe(state);
    expect(first.expectedRevision).toBe(3);
    expect(first.computeBilling).toBe("external");
    const replay = boxliteTemplatePublication(
      entry,
      { resource: { ...current.resource, state, revision: 4 }, configuration: first.configuration },
      "new",
      "owned",
    );
    expect(replay).toEqual(first);
    expect(first.configuration.compute).toEqual(config.compute);
    expect(first.configuration.storage).toEqual(config.storage);
  },
);
it("refuses changed backend connection during node publication", () => {
  const config = configuration(),
    entry = { resource: {}, configurationIdentity: configurationIdentity(config) };
  const changed = structuredClone(config);
  changed.storage.token = "new-secret";
  expect(() =>
    boxliteTemplatePublication(entry, { configuration: changed }, "new", "owned"),
  ).toThrow("configuration changed");
});
it("resolves local verification routes without persisting IP addresses or changing credentials", () => {
  const config = configuration(),
    copy = boxliteVerificationConfiguration(config, (name) =>
      name === "pi-cloud-boxlite" ? "10.43.1.1" : "10.43.1.2",
    );
  expect(copy.compute.url).toBe("http://10.43.1.1:8091/");
  expect(copy.storage.url).toBe("http://10.43.1.2:4500/");
  expect(config).toEqual(configuration());
  expect(copy.compute.token).toBe(config.compute.token);
});
