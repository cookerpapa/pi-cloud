import { expect, it } from "vitest";
import { decodeSessionLogFact, encodeSessionLogFact } from "../src/kafka-accepted-fact.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";

it("round-trips compact ownership, child views and the original reply identity", () => {
  const { fact, command } = toolInvocationFixture("NUL \u0000 lone \ud800");
  const child = { ...fact.scope, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  Object.assign(fact.tools[0]!, { scope: child });
  const source = {
    ...fact,
    cancellations: [
      {
        kind: "tool_cancel" as const,
        scope: child,
        request: {
          activationId: command.request.activationId,
          operationId: command.request.operationId,
        },
      },
    ],
    display: [{ scope: child, events: [], coveredThrough: 12 }],
  };
  const encoded = encodeSessionLogFact(source),
    wire = JSON.parse(encoded);
  expect(wire.replyTopic).toBe("reply-worker-boot");
  expect(wire.tools[0].view).toEqual({ sessionId: child.sessionId, turnId: child.turnId });
  for (const name of ["scope", "replyTopic", "toolCallId", "factId", "nativeToolName"])
    expect(wire.tools[0]).not.toHaveProperty(name);
  expect(wire.tools[0].request).not.toHaveProperty("type");
  expect(wire.tools[0].request).not.toHaveProperty("toolBrokerProtocolVersion");
  expect(wire.cancellations[0]).not.toHaveProperty("kind");
  expect(wire.cancellations[0]).not.toHaveProperty("factId");
  const decoded = decodeSessionLogFact(encoded);
  expect(decoded.fact).toEqual(source);
  expect(decoded.tools[0]).toMatchObject({
    scope: child,
    toolCallId: "task:4",
    replyTopic: "reply-worker-boot",
    request: { operationId: command.request.operationId, toolCallId: "provider-1" },
  });
  expect(decoded.fact.kind === "durable_commit" && decoded.fact.commit).toEqual(fact.commit);
});

it("rejects duplicated fields, changed owners and standalone effects", () => {
  const { fact } = toolInvocationFixture();
  expect(() => decodeSessionLogFact(JSON.stringify(fact))).toThrow();
  for (const field of ["scope", "toolCallId", "factId", "replyTopic", "nativeToolName"]) {
    const wire = JSON.parse(encodeSessionLogFact(fact));
    wire.tools[0][field] = "obsolete";
    expect(() => decodeSessionLogFact(JSON.stringify(wire))).toThrow();
  }
  for (const kind of ["tool_command", "tool_cancel"])
    expect(() => decodeSessionLogFact(JSON.stringify({ kind }))).toThrow("Obsolete");
  const mismatch = structuredClone(fact);
  Object.assign(mismatch.tools[0]!, {
    scope: { ...mismatch.tools[0]!.scope, writerId: crypto.randomUUID() },
  });
  expect(() => encodeSessionLogFact(mismatch)).toThrow("owner changed");
});

it("inherits display addresses without leaking owner fields into public events", () => {
  const { fact } = toolInvocationFixture();
  const source = {
    ...fact,
    display: [
      {
        scope: fact.scope,
        events: [
          {
            event: {
              schemaVersion: 1 as const,
              eventId: crypto.randomUUID(),
              sessionId: fact.scope.sessionId,
              turnId: fact.scope.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: fact.occurredAt,
              type: "assistant.text.delta" as const,
              payload: { messageId: "live", replace: true },
            },
            source: { kind: "empty" as const },
          },
        ],
      },
    ],
  };
  const wire = JSON.parse(encodeSessionLogFact(source));
  expect(wire.display[0].events[0].event).not.toHaveProperty("sessionId");
  expect(decodeSessionLogFact(JSON.stringify(wire)).fact).toEqual(source);
});

it("shares owner metadata for grouped execution probes", () => {
  const { fact } = toolInvocationFixture();
  const probe = {
    kind: "path_probe" as const,
    factId: crypto.randomUUID(),
    scope: fact.scope,
    occurredAt: fact.occurredAt,
    execution: {
      replyTopic: "reply-worker-boot",
      bindings: [
        {
          bindingId: crypto.randomUUID(),
          probe: true,
          scope: { ...fact.scope, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() },
        },
      ],
    },
  };
  const wire = JSON.parse(encodeSessionLogFact(probe));
  expect(wire.execution.bindings[0]).not.toHaveProperty("scope");
  expect(decodeSessionLogFact(JSON.stringify(wire)).fact).toEqual(probe);
});
