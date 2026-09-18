import { expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  ControlToSupervisorMessageSchema,
  PiCloudEventSchema,
  SupervisorToControlMessageSchema,
  createExecutionReference,
  parseControlToSupervisorMessage,
  parsePiCloudEvent,
  parseSupervisorToControlMessage,
} from "../src/index.ts";
import { createSchemaCheck as browserCheck } from "../src/schema-check.browser.ts";

vi.mock("typebox/value", async (original) => {
  const module = await original<typeof import("typebox/value")>();
  return { ...module, Value: { ...module.Value, Check: vi.fn(module.Value.Check) } };
});

const id = "11111111-1111-4111-8111-111111111111";
const time = "2026-09-19T00:00:00.000Z";
const event = {
  schemaVersion: 1,
  eventId: id,
  sessionId: "session",
  turnId: "turn",
  agentId: "root",
  seq: 1,
  occurredAt: time,
  type: "assistant.text.delta",
  payload: { text: "中文😀\nstream" },
};
const envelope = { protocolVersion: 1, messageId: id, sentAt: time };
const reference = createExecutionReference(id, id, 1);
const fixtures: Array<{
  schema: TSchema;
  value: Record<string, unknown>;
  parse(value: unknown): unknown;
  errorPrefix: string;
}> = [
  {
    schema: PiCloudEventSchema,
    value: event,
    parse: parsePiCloudEvent,
    errorPrefix: "Invalid PiCloud event",
  },
  {
    schema: SupervisorToControlMessageSchema,
    value: {
      ...envelope,
      type: "event.publish",
      payload: { executionReference: reference, event },
    },
    parse: parseSupervisorToControlMessage,
    errorPrefix: "Invalid supervisor-to-control message",
  },
  {
    schema: ControlToSupervisorMessageSchema,
    value: {
      ...envelope,
      type: "event.ack",
      payload: { sessionId: "session", executionReference: reference, acknowledgedThroughSeq: 1 },
    },
    parse: parseControlToSupervisorMessage,
    errorPrefix: "Invalid control-to-supervisor message",
  },
];

it("uses compiled server checks rather than interpreting each valid event", () => {
  const interpreted = vi.mocked(Value.Check);
  interpreted.mockClear();
  for (const { value, parse } of fixtures) expect(parse(value)).toBe(value);
  expect(interpreted).not.toHaveBeenCalled();
});

function paths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, item]) => [
    [...prefix, key],
    ...(item && typeof item === "object"
      ? paths(item as Record<string, unknown>, [...prefix, key])
      : []),
  ]);
}

it.each(fixtures)(
  "preserves acceptance, error text and object identity: $errorPrefix",
  ({ schema, value, parse, errorPrefix }) => {
    const checkBrowser = browserCheck(schema);
    const cases: unknown[] = [
      value,
      null,
      undefined,
      [],
      false,
      0,
      "x",
      {},
      NaN,
      Infinity,
      { ...value, unexpected: 1 },
    ];
    for (const path of paths(value)) {
      for (const replacement of [
        undefined,
        null,
        {},
        [],
        true,
        0,
        -1,
        NaN,
        Infinity,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        "",
        "bad",
        "中文😀".repeat(100),
        "a".repeat(255),
        "a".repeat(256),
        "a".repeat(257),
        "😀".repeat(128),
        "😀".repeat(256),
        "😀".repeat(257),
      ]) {
        const candidate = structuredClone(value);
        let parent = candidate;
        for (const part of path.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
        parent[path.at(-1)!] = replacement;
        cases.push(candidate);
      }
      const missing = structuredClone(value);
      let parent = missing;
      for (const part of path.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
      delete parent[path.at(-1)!];
      cases.push(missing);
    }
    for (const candidate of cases) {
      const before = structuredClone(candidate);
      const accepted = Value.Check(schema, candidate);
      expect(checkBrowser(candidate)).toBe(accepted);
      if (accepted) expect(parse(candidate)).toBe(candidate);
      else {
        const issue = [...Value.Errors(schema, candidate)][0];
        const location = issue?.instancePath.length ? issue.instancePath : "/";
        expect(() => parse(candidate)).toThrow(
          `${errorPrefix} at ${location}: ${issue?.message ?? "schema validation failed"}`,
        );
      }
      expect(candidate).toEqual(before);
    }
  },
);
