import { expect, it } from "vitest";
import {
  parseAttachmentReference,
  parseUserUpload,
  parseReuseAttachmentRequest,
  validateImageReferencePayload,
} from "../src/index.ts";

const id = "10000000-0000-4000-8000-000000000001";
const source = { id, mimeType: "text/plain", byteLength: 150000, sha256: "a".repeat(64) };
it("carries a bounded original reference and rejects mismatched upload metadata", () => {
  const upload = {
    id,
    sessionId: id,
    workspaceId: id,
    name: "日志.txt",
    path: "/workspace/uploads/log.txt",
    byteLength: source.byteLength,
    sha256: source.sha256,
    mimeType: source.mimeType,
    original: { type: "pi_cloud_attachment_v1", attachment: source },
  };
  expect(parseUserUpload(upload).original?.attachment).toEqual(source);
  expect(JSON.stringify(upload).length).toBeLessThan(1000);
  expect(() => parseUserUpload({ ...upload, sha256: "b".repeat(64) })).toThrow("metadata changed");
  expect(() => parseAttachmentReference({ ...source, data: "inline body" })).toThrow();
  expect(() =>
    validateImageReferencePayload({
      type: "pi_cloud_attachment_v1",
      attachment: { ...source, sha256: "bad" },
    }),
  ).toThrow();
});
it("accepts only a scoped original reuse request and a single filename", () => {
  const request = { sourceSessionId: id, attachmentId: id, name: "日志.txt" };
  expect(parseReuseAttachmentRequest(request)).toEqual(request);
  expect(() => parseReuseAttachmentRequest({ ...request, name: "../log.txt" })).toThrow();
  expect(() => parseReuseAttachmentRequest({ ...request, sourceSessionId: "missing" })).toThrow();
  expect(() => parseReuseAttachmentRequest({ ...request, body: "inline" })).toThrow();
});
