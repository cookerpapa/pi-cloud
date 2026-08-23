import { describe, expect, it } from "vitest";
import {
  SandboxPreviewProtocolError,
  parseSandboxPreviewRequest,
  parseSandboxPreviewResponse,
} from "../src/index.ts";

describe("private Sandbox preview protocol", () => {
  const request = {
    sandboxPreviewProtocolVersion: 1,
    type: "sandbox_preview.request",
    requestId: "10000000-0000-4000-8000-000000000001",
    tenantId: "10000000-0000-4000-8000-000000000002",
    userId: "10000000-0000-4000-8000-000000000003",
    target: {
      kind: "development_environment",
      environmentId: "10000000-0000-4000-8000-000000000004",
    },
    port: 8000,
    method: "GET",
    path: "/",
    headers: { accept: "text/html" },
  } as const;

  it("accepts arbitrary application ports while reserving the trusted ingress", () => {
    expect(parseSandboxPreviewRequest({ ...request, port: 5173 })).toMatchObject({
      port: 5173,
      method: "GET",
    });
    expect(() => parseSandboxPreviewRequest({ ...request, port: 22 })).toThrow(
      SandboxPreviewProtocolError,
    );
    expect(() => parseSandboxPreviewRequest({ ...request, port: 49_984 })).toThrow(
      SandboxPreviewProtocolError,
    );
    expect(() => parseSandboxPreviewRequest({ ...request, admin: true })).toThrow(
      SandboxPreviewProtocolError,
    );
  });

  it("keeps private ingress identity out of the public response", () => {
    const response = parseSandboxPreviewResponse({
      sandboxPreviewProtocolVersion: 1,
      type: "sandbox_preview.response",
      requestId: request.requestId,
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("ok").toString("base64"),
    });
    expect(response).toMatchObject({ status: 200 });
    expect(JSON.stringify(response)).not.toContain("trafficAccessToken");
  });
});
