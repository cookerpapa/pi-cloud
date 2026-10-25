import { it, expect } from "vitest";
import {
  firstJsonObject,
  humanPresentationSliceCharacters,
} from "../src/durable/human-input-presentation.ts";

it("extracts one complete metadata object without interpreting trailing input text", () => {
  const value = {
    text: 'quoted " } ] { \\ 😀 \u0000\ud800',
    uploads: [{ name: 'a } " b' }],
    nativeId: 7,
  };
  expect(firstJsonObject(JSON.stringify(value) + ',"another":{"text":"unfinished')).toEqual(value);
  expect(() => firstJsonObject('{"text":"truncated')).toThrow("boundary");
  expect(() => firstJsonObject("null")).toThrow("missing");
  expect(humanPresentationSliceCharacters(10 ** 9)).toBe(900 * 1024);
});
