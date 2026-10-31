import { expect, it } from "vitest";
import { parseAcceptTurnRequest } from "../src/control-plane-api.ts";

it("accepts a busy preference without a browser-selected Run target", () => {
  for (const whenBusy of ["follow_up", "steer"] as const)
    expect(parseAcceptTurnRequest({ prompt: "Continue", whenBusy })).toEqual({
      prompt: "Continue",
      whenBusy,
    });
  expect(parseAcceptTurnRequest({ prompt: "Start" })).toEqual({ prompt: "Start" });
  expect(() => parseAcceptTurnRequest({ prompt: "x", whenBusy: "interrupt" })).toThrow();
  expect(() => parseAcceptTurnRequest({ prompt: "x", targetTurnId: "old-run" })).toThrow();
});
