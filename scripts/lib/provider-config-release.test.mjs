import { expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { initialProviderConfiguration } from "./provider-runtime-config.mjs";
import {
  providerConfigDigest,
  prepareProviderConfiguration,
  assertProviderConfigurationPlan,
  applyProviderConfiguration,
} from "./provider-config-release.mjs";

const initial = () =>
  initialProviderConfiguration({ apiKey: "client-fixture", managementKey: "management-fixture" });

it("prepares policy and pinned UI without losing operator credentials or provider values", async () => {
  const value = parse(initial());
  value.routing.retry["request-retry"] = 3;
  value["api-keys"] = {
    "openai-compatibility": [
      {
        name: "native",
        "wire-api": "responses",
        keys: [{ "api-key": "upstream-fixture", "proxy-url": "direct" }],
      },
    ],
  };
  const source = stringify(value);
  const prepared = await prepareProviderConfiguration(source, (body) => stringify(parse(body)));
  const changed = parse(prepared.body);
  expect(changed.access).toEqual(value.access);
  expect(changed["api-keys"]).toEqual(value["api-keys"]);
  expect(changed.management["secret-key"]).toBe("management-fixture");
  expect(changed.routing.retry["request-retry"]).toBe(0);
  expect(() => assertProviderConfigurationPlan(prepared.plan, prepared.body, source)).not.toThrow();
  expect(() =>
    assertProviderConfigurationPlan(prepared.plan, prepared.body, prepared.body),
  ).not.toThrow();
  expect(() =>
    assertProviderConfigurationPlan(prepared.plan, prepared.body, source + "# later edit\n"),
  ).toThrow("changed after preparation");
});

it.each([false, true])(
  "confirms a committed configuration after a normal or lost PUT response (%s)",
  async (lost) => {
    const source = "port: 8317\n";
    const body = initial();
    const plan = {
      version: 1,
      sourceDigest: providerConfigDigest(source),
      desiredDigest: providerConfigDigest(body),
    };
    let current = source;
    let puts = 0;
    const call = () =>
      applyProviderConfiguration({
        baseUrl: "http://provider",
        managementKey: "fixture",
        plan,
        body,
        fetchImplementation: async (url, options) => {
          expect(url.pathname).toBe("/v8/management/config.yaml");
          if (options.method === "PUT") {
            expect(options.headers["if-match"]).toBe(`"${providerConfigDigest(current)}"`);
            puts++;
            current = options.body;
            if (lost) throw new Error("response lost");
            return Response.json({ status: "ok" });
          }
          return new Response("private configuration", {
            headers: { etag: `"${providerConfigDigest(current)}"` },
          });
        },
      });
    expect(await call()).toEqual({ adopted: true, version: 8 });
    expect(await call()).toEqual({ adopted: true, version: 8 });
    expect(puts).toBe(1);
  },
);

it("refuses concurrent operator changes without overwriting them", async () => {
  let writes = 0;
  const body = initial();
  await expect(
    applyProviderConfiguration({
      baseUrl: "http://provider",
      managementKey: "fixture",
      body,
      plan: {
        version: 1,
        sourceDigest: providerConfigDigest("before"),
        desiredDigest: providerConfigDigest(body),
      },
      fetchImplementation: async (_url, options) => {
        if (options.method === "PUT") writes++;
        return new Response("", {
          headers: { etag: `"${providerConfigDigest("operator-edit")}"` },
        });
      },
    }),
  ).rejects.toThrow("changed after preparation");
  expect(writes).toBe(0);
});
