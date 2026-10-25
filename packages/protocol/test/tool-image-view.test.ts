import { expect, it } from "vitest";
import { toolContentView, toolImageView } from "../src/tool-image-view.ts";
const id = "10000000-0000-4000-8000-000000000001";
const packed = {
  type: "pi_cloud_image_v1",
  attachment: { id, sha256: "a".repeat(64), byteLength: 4, mimeType: "image/png" },
};
it("derives the public address from the final attachment and the current view's Session", () => {
  const part = toolImageView("fork-session", packed);
  expect(part).toEqual({
    type: "image",
    imageId: id,
    mimeType: "image/png",
    previewPath: `/v1/sessions/fork-session/images/${id}`,
  });
  expect(toolContentView("fork-session", [{ type: "text", text: "shown" }, packed])).toEqual([
    { type: "text", text: "shown" },
    part,
  ]);
});
it("rejects raw pixels and invalid references instead of promoting them to browser content", () => {
  expect(() => toolImageView("session", { type: "image", data: "pixels" })).toThrow();
  expect(() => toolContentView("session", [{ type: "image", data: "pixels" }])).toThrow();
  expect(() =>
    toolImageView("session", { ...packed, attachment: { ...packed.attachment, sha256: "wrong" } }),
  ).toThrow();
});
