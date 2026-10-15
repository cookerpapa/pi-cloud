import type {
  SessionLogFact,
  AcceptedFactScope,
  AcceptedDurableCommitFact,
} from "./accepted-fact.ts";

type ObjectValue = Record<string, unknown>;
type View = Pick<AcceptedFactScope, "sessionId" | "turnId">;
const ownerFields = ["tenantId", "piSessionId", "runId", "writerId", "fencingToken"] as const;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Session log envelope object");
  return value as ObjectValue;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Invalid Session log envelope list");
  return value;
};
function keys(value: ObjectValue, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected Session log envelope field");
}
function view(scope: AcceptedFactScope, root: AcceptedFactScope): View {
  for (const field of ownerFields)
    if (scope[field] !== root[field]) throw new Error("Nested publication owner changed");
  return { sessionId: scope.sessionId, turnId: scope.turnId };
}
function scope(root: AcceptedFactScope, value: unknown): AcceptedFactScope {
  const address = object(value);
  keys(address, ["sessionId", "turnId"]);
  if (
    [address.sessionId, address.turnId].some(
      (id) => typeof id !== "string" || !id || id.length > 512,
    )
  )
    throw new Error("Invalid Conversation view address");
  return { ...root, sessionId: address.sessionId as string, turnId: address.turnId as string };
}
function rootScope(value: unknown): AcceptedFactScope {
  const root = object(value);
  keys(root, [...ownerFields, "sessionId", "turnId"]);
  for (const field of ["tenantId", "piSessionId", "runId", "writerId", "sessionId", "turnId"])
    if (typeof root[field] !== "string" || !root[field] || (root[field] as string).length > 512)
      throw new Error("Invalid publication identity");
  if (!Number.isSafeInteger(root.fencingToken) || (root.fencingToken as number) < 1)
    throw new Error("Invalid publication epoch");
  return root as unknown as AcceptedFactScope;
}
function compactEvent(description: ObjectValue, address: View): ObjectValue {
  const event = object(description.event);
  if (
    event.sessionId !== address.sessionId ||
    event.turnId !== address.turnId ||
    event.schemaVersion !== 1
  )
    throw new Error("Display event belongs to another Conversation view");
  const { sessionId: _session, turnId: _turn, schemaVersion: _version, ...metadata } = event;
  return { ...description, event: metadata };
}
function expandEvent(description: unknown, address: View): ObjectValue {
  const value = object(description),
    event = object(value.event);
  if ("sessionId" in event || "turnId" in event || "schemaVersion" in event)
    throw new Error("Display envelope duplicates its Conversation view");
  return {
    ...value,
    event: { ...event, schemaVersion: 1, sessionId: address.sessionId, turnId: address.turnId },
  };
}

/** Only this compact format goes to Kafka. Native Storage writes stay intact;
 * expanded adapter objects and cold control metadata are not wire formats. */
export function encodeSessionLogFact(fact: SessionLogFact): string {
  if (fact.kind === "durable_commit") {
    const replyTopic = fact.tools[0]?.replyTopic;
    if (
      fact.tools.some((tool) => tool.replyTopic !== replyTopic) ||
      (fact.tools.length && (typeof replyTopic !== "string" || !replyTopic))
    )
      throw new Error("One native commit must use its original Worker reply Topic");
    return JSON.stringify({
      ...fact,
      ...(replyTopic ? { replyTopic } : {}),
      tools: fact.tools.map((tool) => {
        const { scope: identity, replyTopic: _reply, ...descriptor } = tool;
        const address = view(identity, fact.scope);
        if (descriptor.target === "control") return { ...descriptor, view: address };
        if (descriptor.target !== "cube") throw new Error("Unknown Tool dispatch target");
        const {
          type: _type,
          toolBrokerProtocolVersion: _protocol,
          ...request
        } = descriptor.request;
        return { ...descriptor, request, view: address };
      }),
      cancellations: fact.cancellations.map((cancel) => ({
        view: view(cancel.scope, fact.scope),
        ...cancel.request,
      })),
      display: fact.display.map((display) => {
        const address = view(display.scope, fact.scope);
        return {
          view: address,
          events: display.events.map((text) => compactEvent(text as unknown as ObjectValue, address)),
          ...(display.coveredThrough === undefined
            ? {}
            : { coveredThrough: display.coveredThrough }),
        };
      }),
    });
  }
  if (fact.kind === "path_probe" && fact.execution)
    return JSON.stringify({
      ...fact,
      execution: {
        ...fact.execution,
        bindings: fact.execution.bindings.map((binding) => ({
          bindingId: binding.bindingId,
          probe: binding.probe,
          view: view(binding.scope, fact.scope),
        })),
      },
    });
  return JSON.stringify(fact);
}

/** Expand shared transport metadata once, before the normal domain validation.
 * No old scope-per-tool or standalone Tool/cancellation format is accepted. */
export function expandSessionLogEnvelope(input: unknown): SessionLogFact {
  const value = object(input);
  if (
    "closesWriter" in value ||
    "retireWriter" in value ||
    value.kind === "tool_cancel" ||
    value.kind === "tool_command"
  )
    throw new Error("Obsolete Session log envelope");
  if (value.kind === "durable_commit") {
    keys(value, [
      "kind",
      "factId",
      "scope",
      "commit",
      "origins",
      "inputQueueSessions",
      "tools",
      "cancellations",
      "display",
      "occurredAt",
      "replyTopic",
    ]);
    const root = rootScope(value.scope);
    const { replyTopic, ...fact } = value;
    const tools = list(value.tools);
    if (
      (tools.length &&
        (typeof replyTopic !== "string" || !replyTopic || replyTopic.length > 249)) ||
      (!tools.length && replyTopic !== undefined)
    )
      throw new Error("Invalid original Worker reply Topic");
    return {
      ...fact,
      tools: tools.map((item) => {
        const tool = object(item);
        if (tool.target === "control") {
          keys(tool, [
            "target",
            "operationId",
            "taskId",
            "conversationId",
            "toolName",
            "contextAnchor",
            "bindingId",
            "sourceDocumentId",
            "replyMode",
            "workflowKey",
            "view",
          ]);
          const { view: address, ...reference } = tool;
          return { ...reference, scope: scope(root, address), replyTopic };
        }
        if (tool.target !== "cube") throw new Error("Unknown Tool dispatch target");
        keys(tool, ["target", "taskId", "request", "occurredAt", "traceContext", "view"]);
        const { view: address, ...reference } = tool;
        const request = object(tool.request);
        if ("type" in request || "toolBrokerProtocolVersion" in request)
          throw new Error("Cube dispatch duplicates protocol constants");
        return {
          ...reference,
          scope: scope(root, address),
          replyTopic,
          request: { ...request, type: "tool_sandbox.operation", toolBrokerProtocolVersion: 1 },
        };
      }),
      cancellations: list(value.cancellations).map((item) => {
        const cancel = object(item);
        keys(cancel, ["view", "activationId", "operationId"]);
        return {
          kind: "tool_cancel",
          scope: scope(root, cancel.view),
          request: { activationId: cancel.activationId, operationId: cancel.operationId },
        };
      }),
      display: list(value.display).map((item) => {
        const display = object(item);
        keys(display, ["view", "events", "coveredThrough"]);
        const target = scope(root, display.view);
        return {
          scope: target,
          events: list(display.events).map((text) => expandEvent(text, target)),
          ...(display.coveredThrough === undefined
            ? {}
            : { coveredThrough: display.coveredThrough }),
        };
      }),
    } as unknown as AcceptedDurableCommitFact;
  }
  if (value.kind === "path_probe" && value.execution) {
    const execution = object(value.execution),
      root = rootScope(value.scope);
    return {
      ...value,
      execution: {
        ...execution,
        bindings: list(execution.bindings).map((item) => {
          const binding = object(item);
          keys(binding, ["bindingId", "probe", "view"]);
          const { view: address, ...rest } = binding;
          return { ...rest, scope: scope(root, address) };
        }),
      },
    } as unknown as SessionLogFact;
  }
  return value as unknown as SessionLogFact;
}
