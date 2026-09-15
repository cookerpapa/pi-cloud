import { describe, expect, it } from "vitest";
import {
  identityDestination,
  loadWebConfiguration,
  type WebConfiguration,
} from "../src/web-configuration.ts";

const configuration: WebConfiguration = {
  productUrl: "https://chat.example.test/",
  adminUrl: "https://admin.example.test/",
  managementUrls: {
    providerGateway: "https://models.example.test/management.html",
    grafana: "",
    prometheus: "",
    alertmanager: "",
    jaeger: "",
  },
};

describe("deployment-owned Web origins", () => {
  it("uses explicit HTTPS origins instead of a port heuristic", () => {
    expect(identityDestination(configuration, true, "https://chat.example.test")).toBe(
      configuration.adminUrl,
    );
    expect(identityDestination(configuration, false, "https://admin.example.test")).toBe(
      configuration.productUrl,
    );
    expect(identityDestination(configuration, true, "https://admin.example.test")).toBeNull();
    expect(identityDestination(configuration, false, "https://chat.example.test")).toBeNull();
  });

  it("supports custom mapped ports and a single-origin local Vite demo", () => {
    const local = {
      ...configuration,
      productUrl: "http://localhost:18080",
      adminUrl: "http://localhost:19090",
    };
    expect(identityDestination(local, true, local.productUrl)).toBe(local.adminUrl);
    expect(identityDestination(local, false, local.adminUrl)).toBe(local.productUrl);
    expect(
      identityDestination({ ...local, adminUrl: local.productUrl }, true, local.productUrl),
    ).toBeNull();
  });

  it("loads public configuration once without guessing missing component links", async () => {
    let calls = 0;
    expect(
      await loadWebConfiguration(async (url, options) => {
        calls++;
        expect(url).toBe("/ui-config.json");
        expect(options?.cache).toBe("no-store");
        return Response.json(configuration);
      }),
    ).toEqual(configuration);
    expect(calls).toBe(1);
  });

  it("surfaces a failed configuration response instead of redirecting to localhost", async () => {
    await expect(
      loadWebConfiguration(async () => new Response(null, { status: 503 })),
    ).rejects.toThrow("HTTP 503");
    for (const productUrl of [
      "",
      "https://chat.example.test/subpath",
      "javascript:alert(1)",
      "http://user:secret@chat.example.test",
    ]) {
      await expect(
        loadWebConfiguration(async () => Response.json({ ...configuration, productUrl })),
      ).rejects.toThrow();
    }
  });
});
