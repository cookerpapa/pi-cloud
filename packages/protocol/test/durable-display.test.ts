import { expect, it } from "vitest";
import {
  createPiCloudEventFactory,
  parseDurableTextDescription,
  resolveDurableText,
  type DurableTextDescription,
} from "../src/index.ts";
const full = createPiCloudEventFactory({
  sessionId: "session",
  turnId: "turn",
  agentId: "agent",
}).next({ type: "assistant.text.delta", payload: { messageId: "message", text: "" } });
if (full.type !== "assistant.text.delta") throw new Error("fixture");
const { text: _text, ...payload } = full.payload;
const description: DurableTextDescription = {
  event: { ...full, payload },
  source: { kind: "document", id: 2, path: ["message"], start: 2, end: 5 },
};
it("resolves Unicode string ranges from the document changed in its own commit", () => {
  const commit = { seq: 1, nextId: 3, writes: [{ type: "document.change", id: 2 }] };
  expect(resolveDurableText(commit, description, () => ({ message: "你好🌍!" })).payload.text).toBe(
    "🌍!",
  );
});
it("rejects copied text, missing or cross-commit sources and malformed ranges", () => {
  expect(() =>
    parseDurableTextDescription({
      ...description,
      event: { ...description.event, payload: { ...payload, text: "copy" } },
    }),
  ).toThrow(/copied/);
  expect(() =>
    parseDurableTextDescription({ ...description, source: { ...description.source, start: -1 } }),
  ).toThrow(/reference/);
  expect(() =>
    resolveDurableText({ seq: 1, nextId: 3, writes: [] }, description, () => ({
      message: "hello",
    })),
  ).toThrow(/part of/);
  expect(() =>
    resolveDurableText(
      { seq: 1, nextId: 3, writes: [{ type: "document.change", id: 2 }] },
      description,
      () => ({ message: "no" }),
    ),
  ).toThrow(/range/);
});
