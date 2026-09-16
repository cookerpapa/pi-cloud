import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpSupervisorManagementClient } from "../src/http-supervisor-management.ts";

const request = () => ({
  protocolVersion: 1 as const,
  type: "assignments.list" as const,
  requestId: randomUUID(),
  sandboxId: randomUUID(),
});

describe("Supervisor management through an ingress", () => {
  it.each([502, 503, 504])(
    "keeps non-JSON HTTP %s retryable during Worker replacement",
    async (status) => {
      const client = new HttpSupervisorManagementClient({
        baseUrl: "http://worker.test",
        managementToken: "test-token-" + "x".repeat(32),
        allowInsecureHttp: true,
        fetchImplementation: async () => new Response("no available server", { status }),
      });
      await expect(client.request(request())).rejects.toMatchObject({ retryable: true });
    },
  );

  it("does not conceal a malformed successful management response", async () => {
    const client = new HttpSupervisorManagementClient({
      baseUrl: "http://worker.test",
      managementToken: "test-token-" + "x".repeat(32),
      allowInsecureHttp: true,
      fetchImplementation: async () => new Response("not the protocol", { status: 200 }),
    });
    await expect(client.request(request())).rejects.toMatchObject({
      code: "supervisor_management_invalid_response",
      retryable: false,
    });
  });
});
