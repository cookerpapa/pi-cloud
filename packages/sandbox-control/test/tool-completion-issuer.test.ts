import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ToolCompletionIssuer } from "../src/tool-completion-issuer.ts";
import {
  ToolCompletionCapabilities,
  type ToolCompletionGrant,
} from "@pi-cloud/protocol/completion-capability";

it("uses the configured routable IP while preserving TLS identity and operation scope", async () => {
  const secret = "test-issuer-".repeat(4);
  const grant: ToolCompletionGrant = {
    operationId: randomUUID(),
    expiresAt: Date.now() + 90_000,
    context: {
      kind: "executor_tool",
      replyTopic: "owned-topic",
      toolCallId: "task:1",
      nativeToolCallId: "call",
      toolName: "local_bash",
      partition: 0,
      scope: {
        tenantId: randomUUID(),
        sessionId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        piSessionId: randomUUID(),
        writerId: randomUUID(),
        fencingToken: 1,
      },
    },
  };
  const issuer = new ToolCompletionIssuer({
    url: "https://tool-completion:30432/v1/completions",
    address: "192.0.2.10",
    ca: "-----BEGIN CERTIFICATE-----fixture",
    secret,
  });
  const destination = await issuer.issue(grant);
  expect(destination.address).toBe("192.0.2.10");
  expect(new URL(destination.url).hostname).toBe("tool-completion");
  expect(new ToolCompletionCapabilities(secret).read(destination.capability)).toEqual(grant);
  expect(() => new ToolCompletionIssuer({ ...issuer.options, address: "unresolved-host" })).toThrow(
    "IP address",
  );
});
