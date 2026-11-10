import { ToolCompletionCapabilities } from "@pi-cloud/protocol/completion-capability";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { type ToolCompletionGrant } from "@pi-cloud/protocol";
import type { CompletionPacket } from "../src/adapter.ts";
import { completionServer } from "../src/http-server.ts";
import { testTls } from "./tls-fixture.ts";

it("conceals routing, scopes Guest replies, and acknowledges only after publication", async () => {
  const tls = await testTls(),
    authority = new ToolCompletionCapabilities("fixture-".repeat(8));
  const grant: ToolCompletionGrant = {
    operationId: randomUUID(),
    expiresAt: Date.now() + 60000,
    context: {
      scope: {
        tenantId: randomUUID(),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        runId: randomUUID(),
        writerId: randomUUID(),
        piSessionId: randomUUID(),
        fencingToken: 1,
      },
      replyTopic: `pi-cloud.tool-replies.v4.${randomUUID()}`,
      toolCallId: "task:7",
      nativeToolCallId: "call",
      toolName: "bash",
      partition: 0,
    },
  };
  const capability = authority.issue(grant);
  expect(capability).not.toContain(grant.context.replyTopic);
  expect(authority.read(capability)).toEqual(grant);
  expect(() => authority.read(capability, grant.expiresAt)).toThrow();
  const published = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const accept = vi.fn(async (_packet: CompletionPacket) => {
    entered.resolve();
    await published.promise;
  });
  const server = completionServer({
    ...tls,
    authority,
    adapter: { accept },
    ready: async () => {},
  });
  const body = {
    kind: "result",
    operationId: grant.operationId,
    output: { type: "worker.failed", code: "fixture" },
  };
  const post = (value: unknown, token = capability) =>
    server.inject({
      method: "POST",
      url: "/v1/completions",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(value),
    });
  try {
    expect((await post(body, capability.slice(0, -8) + "AAAAAAAA")).statusCode).toBe(401);
    expect((await post({ ...body, operationId: randomUUID() })).statusCode).toBe(409);
    expect((await post({ ...body, context: { replyTopic: "other" } })).statusCode).toBe(409);
    expect((await post({ ...body, result: { quarantine: true } })).statusCode).toBe(409);
    let acknowledged = false;
    const waiting = post(body).then((response) => {
      acknowledged = true;
      return response;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    published.resolve();
    expect((await waiting).statusCode).toBe(204);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept.mock.calls[0]?.[0]).toMatchObject({
      operationId: grant.operationId,
      context: grant.context,
      result: { output: body.output },
    });
  } finally {
    published.resolve();
    await server.close();
  }
});
