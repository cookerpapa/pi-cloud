import { expect, it } from "vitest";
import { validateImageReferencePayload } from "../src/image-attachment.ts";
it("rejects inline images and malformed or external-address references at the Kafka boundary", () => {
  expect(() =>
    validateImageReferencePayload({
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
    }),
  ).toThrow("forbidden");
  expect(() =>
    validateImageReferencePayload({
      type: "pi_cloud_image_v1",
      attachment: { url: "https://example.com/image" },
    }),
  ).toThrow("Invalid");
});
