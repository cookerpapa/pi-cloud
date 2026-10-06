import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { truncateHead, truncateTail } from "../src/tool-output-truncation.ts";
import { truncationInputs } from "./fixtures/truncation-inputs.ts";

it("matches 1100 results captured from the published Pi 1.0.0 truncation helpers", () => {
  const outputs = truncationInputs().flatMap(({ content, options }) => [
    truncateHead(content, options),
    truncateTail(content, options),
  ]);
  expect(outputs).toHaveLength(1100);
  // Captured before removing the CLI dependency, not calculated from this implementation.
  expect(createHash("sha256").update(JSON.stringify(outputs)).digest("hex")).toBe(
    "bcd5577c721d7f91700d89f259e0ad65843692eda0cd6cf450e7f23da82c9cbb",
  );
});
it("retains UTF-8 boundaries and distinguishes an oversized first line from a tail fragment", () => {
  expect(truncateHead("中文一行\nnext", { maxBytes: 5 })).toMatchObject({
    content: "",
    firstLineExceedsLimit: true,
    truncatedBy: "bytes",
  });
  expect(truncateTail("🙂".repeat(5), { maxBytes: 5 })).toMatchObject({
    content: "🙂",
    lastLinePartial: true,
    outputBytes: 4,
  });
});
