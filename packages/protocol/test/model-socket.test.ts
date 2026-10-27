import { expect, it } from "vitest";
import { encodeModelSocketRequest, parseModelSocketRequest } from "../src/model-socket.ts";

it("preserves native JSON bytes, including escapes, without changing the request prefix", () => {
  const sampling = { stepSequence: 7, stepSha256: "a".repeat(64), samplingAttempt: 2 };
  const body = JSON.stringify({
    type: "response.create",
    input: '\0\n\\"\ud800中文',
    image: "base64-test",
  });
  const frame = encodeModelSocketRequest(sampling, body);
  expect(parseModelSocketRequest(frame)).toEqual({ protocolVersion: 1, sampling, request: body });
  expect(frame.endsWith(body)).toBe(true);
  expect(frame.length - body.length).toBeLessThan(200);
});

it.each([
  "{}",
  '{"protocolVersion":2,"sampling":{}}\n{}',
  '{"protocolVersion":1,"sampling":{}}\n{}',
  "x".repeat(4097) + "\n{}",
])("rejects an unrecognized or invalid sampling frame", (frame) => {
  expect(() => parseModelSocketRequest(frame)).toThrow();
});
