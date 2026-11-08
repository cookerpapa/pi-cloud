import { expect, it } from "vitest";
import { decodeSessionLogFact, encodeSessionLogFact } from "../src/kafka-accepted-fact.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import {
  createExecutionReference,
  type ToolEnvironmentRequest,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";

function logicalEnvironment(f: ReturnType<typeof toolInvocationFixture>): ToolEnvironmentRequest {
  const s = f.fact.scope;
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_environment",
    requestId: f.command.request.activationId,
    piSessionId: s.piSessionId,
    conversationId: 1,
    workspaceSeedKind: "empty",
    executionMode: "elastic",
    sandboxProfileKey: "standard",
    toolRoot: "/workspace",
    allowedTools: ["read", "write", "edit", "bash"],
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    assignment: {
      tenantId: s.tenantId,
      projectId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: s.sessionId,
      runId: s.runId,
      turnId: s.turnId,
      supervisorId: "fixture",
      sandboxId: crypto.randomUUID(),
      bootId: crypto.randomUUID(),
      executionReference: createExecutionReference(s.writerId, s.runId, s.fencingToken),
    },
    environment: {
      environmentVersionId: crypto.randomUUID(),
      versionNumber: 1,
      profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
      profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
      imageRevision: "development",
      specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
  };
}

it("round-trips the actual logical environment on complete fixed Tool intents", () => {
  const f = toolInvocationFixture(),
    environment = logicalEnvironment(f);
  f.fact.tools[0] = { ...f.fact.tools[0]!, environment };
  const decoded = decodeSessionLogFact(encodeSessionLogFact(f.fact));
  expect(decoded.fact).toEqual(f.fact);
  expect(decoded.tools[0]).toMatchObject({
    environment,
    request: { args: { path: "large.txt", content: "hello" } },
  });
  const invalid = JSON.parse(encodeSessionLogFact(f.fact));
  invalid.tools[0].environment.requestId = crypto.randomUUID();
  expect(() => decodeSessionLogFact(JSON.stringify(invalid))).toThrow("binding identity");
});

it("round-trips ordinary Tool environment and frozen implementation without duplicating arguments", () => {
  const f = toolInvocationFixture(),
    environment = logicalEnvironment(f);
  const tool = {
    target: "control" as const,
    scope: f.fact.scope,
    taskId: 4,
    conversationId: 1,
    operationId: crypto.randomUUID(),
    toolName: "preview",
    contextAnchor: null,
    replyTopic: "reply-worker-boot",
    bindingId: environment.requestId,
    environment,
    implementation: { releaseId: "release-1", generation: 1, replay: "safe" as const },
  };
  const fact = { ...f.fact, tools: [tool] };
  const wire = encodeSessionLogFact(fact);
  expect(JSON.parse(wire).tools[0]).not.toHaveProperty("arguments");
  expect(decodeSessionLogFact(wire).fact).toEqual(fact);
  const invalid = JSON.parse(wire);
  invalid.tools[0].implementation.generation = 0;
  expect(() => decodeSessionLogFact(JSON.stringify(invalid))).toThrow("implementation");
});

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

it("routes Android using the native intent once, with ordered position and no duplicate arguments", () => {
  const { fact } = toolInvocationFixture("phone input");
  const source: import("../src/accepted-fact.ts").AcceptedDurableCommitFact = {
    ...fact,
    tools: [
      {
        target: "executor",
        scope: fact.scope,
        operationId: crypto.randomUUID(),
        bindingId: crypto.randomUUID(),
        taskId: 4,
        conversationId: 1,
        toolName: "android_input_text",
        replyTopic: "reply-worker-boot",
      },
    ],
    cancellations: [
      {
        kind: "tool_cancel",
        scope: fact.scope,
        request: {
          target: "executor",
          operationId: crypto.randomUUID(),
          activationId: crypto.randomUUID(),
        },
      },
    ],
  };
  const wire = encodeSessionLogFact(source);
  expect(JSON.parse(wire).tools[0]).not.toHaveProperty("arguments");
  const decoded = decodeSessionLogFact(wire);
  expect(decoded.fact).toEqual(source);
  expect(decoded.tools[0]).toMatchObject({
    kind: "executor_tool",
    operationIndex: 0,
    nativeCallId: "provider-1",
    arguments: { content: "phone input" },
  });
  const malformed = JSON.parse(wire);
  malformed.tools[0].arguments = { text: "other input" };
  expect(() => decodeSessionLogFact(JSON.stringify(malformed))).toThrow();
});
