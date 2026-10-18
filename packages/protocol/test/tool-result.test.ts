import { expect, it } from "vitest";
import { parseToolResultPayload, parsePackedToolResultPayload } from "../src/tool-result.ts";
import { parseNativeToolEvent } from "../src/native-tool-event.ts";

const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const packed = {
  type: "pi_cloud_image_v1",
  attachment: {
    id: "10000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
    byteLength: 5,
    mimeType: "image/png",
  },
};
const payload = (content: unknown[]) => ({
  toolName: "read",
  toolCallId: "call",
  result: {
    content,
    details: { type: "image", data: { opaque: true } },
    diagnostics: [{ severity: "warn", code: "truncated", message: "Read more explicitly" }],
  },
  isError: false,
});

it("keeps native image bytes and packed references in distinct contracts", () => {
  expect(parseToolResultPayload(payload([image]))).toEqual(payload([image]));
  expect(parsePackedToolResultPayload(payload([packed]))).toEqual(payload([packed]));
  expect(() => parseToolResultPayload(payload([packed]))).toThrow();
  expect(() => parsePackedToolResultPayload(payload([image]))).toThrow();
  expect(parseNativeToolEvent({ type: "tool_execution_end", ...payload([image]) })).toMatchObject(
    payload([image]),
  );
  expect(() =>
    parseNativeToolEvent({ type: "tool_execution_end", ...payload([packed]) }),
  ).toThrow();
});
it.each(
  [[], [{ type: "text", text: "" }], [{ type: "text", text: "\u0000中😀" }]].map((content) => ({
    content,
  })),
)("preserves empty and valid text with opaque details: %j", ({ content }) => {
  expect(parseToolResultPayload(payload(content))).toEqual(payload(content));
  expect(parsePackedToolResultPayload(payload(content))).toEqual(payload(content));
});
it.each([
  null,
  17,
  { type: "unexpected" },
  { type: "text", text: 17 },
  { type: "text", text: null },
  { type: "text" },
  { type: "text", text: "ok", data: "hidden" },
])("rejects invalid content in both representations: %j", (part) => {
  expect(() => parseToolResultPayload(payload([part]))).toThrow();
  expect(() => parsePackedToolResultPayload(payload([part]))).toThrow();
});
it.each([
  { ...image, data: null },
  { ...image, data: "" },
  { ...image, mimeType: 17 },
  { ...image, mimeType: "application/octet-stream" },
])("rejects malformed native image parts: %j", (part) => {
  expect(() => parseToolResultPayload(payload([part]))).toThrow();
});
it.each([
  { ...packed, attachment: null },
  { ...packed, attachment: { ...packed.attachment, byteLength: 0 } },
  { ...packed, data: "hidden" },
])("rejects malformed image references: %j", (part) => {
  expect(() => parsePackedToolResultPayload(payload([part]))).toThrow();
});
