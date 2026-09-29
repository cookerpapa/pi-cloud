import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { inputWithUploads, parseUserUploads, uploadFileName } from "../src/user-upload.ts";
import { parseAcceptTurnRequest, parseCreateTurnSteerRequest } from "../src/control-plane-api.ts";

it("accepts attachment-only input and preserves bounded identities without accepting inline bytes", () => {
  const uploadIds = [randomUUID()];
  expect(parseAcceptTurnRequest({ prompt: "", uploadIds })).toEqual({ prompt: "", uploadIds });
  expect(parseCreateTurnSteerRequest({ text: "", uploadIds })).toEqual({ text: "", uploadIds });
  expect(() => parseAcceptTurnRequest({ prompt: " " })).toThrow();
  expect(() => parseCreateTurnSteerRequest({ text: "" })).toThrow();
  expect(() =>
    parseAcceptTurnRequest({ prompt: "x", uploadIds: [uploadIds[0], uploadIds[0]] }),
  ).toThrow();
  expect(() => parseAcceptTurnRequest({ prompt: "x", uploads: [{ data: "inline" }] })).toThrow();
});

it("describes filenames as escaped data and bounds aggregate attachments", () => {
  const upload = {
    id: randomUUID(),
    sessionId: randomUUID(),
    workspaceId: randomUUID(),
    name: 'a"<tag>.txt',
    path: '/workspace/a"<tag>.txt',
    mimeType: "application/octet-stream",
    byteLength: 16 * 1024 * 1024,
    sha256: "a".repeat(64),
  };
  const body = inputWithUploads("User text", [upload]);
  expect(body.startsWith("User text\n\n")).toBe(true);
  expect(JSON.parse(body.split("\n").at(-1)!)).toMatchObject({
    name: upload.name,
    path: upload.path,
    bytes: upload.byteLength,
  });
  expect(() =>
    parseUserUploads([upload, { ...upload, id: randomUUID() }, { ...upload, id: randomUUID() }]),
  ).toThrow("budget");
  expect(() => parseUserUploads([upload, upload])).toThrow("budget");
  for (const name of ["../x", "/x", "..", "a\nb", "a\\b", "界".repeat(81)])
    expect(() => uploadFileName(name)).toThrow();
});
