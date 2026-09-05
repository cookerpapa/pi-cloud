import { describe, expect, it } from "vitest";
import { parseSandboxPreviewConnection } from "../src/index.ts";

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  workspaceId: "10000000-0000-4000-8000-000000000003",
  target: {
    kind: "development_environment",
    environmentId: "10000000-0000-4000-8000-000000000004",
  },
  port: 4173,
  expiresAt: Date.now() + 60_000,
};
describe("private application CONNECT scope", () => {
  it("accepts an application port without carrying HTTP body or Cube credentials", () => {
    expect(parseSandboxPreviewConnection(scope)).toEqual(scope);
    expect(() =>
      parseSandboxPreviewConnection({ ...scope, trafficAccessToken: "secret" }),
    ).toThrow();
    expect(() => parseSandboxPreviewConnection({ ...scope, body: "payload" })).toThrow();
  });
  it.each([22, 49983, 49984, 50005, 65536])("rejects invalid/management port %s", (port) => {
    expect(() => parseSandboxPreviewConnection({ ...scope, port })).toThrow();
  });
});
