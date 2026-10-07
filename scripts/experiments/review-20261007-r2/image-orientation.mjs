// Verifies the repaired image boundary; original dimensions remain in the review JSON.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { processImageSource } from "../../../packages/tool-sandbox/src/image-processor.ts";

const input = await sharp({
  create: { width: 80, height: 40, channels: 3, background: "#229944" },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer();
const before = await sharp(input).metadata();
const expected = await sharp(input).autoOrient().png().toBuffer({ resolveWithObject: true });
const result = await processImageSource(input, { autoResizeImages: true });
const actual = await sharp(Buffer.from(result.data, "base64")).metadata();
assert.equal(before.orientation, 6);
assert.deepEqual([expected.info.width, expected.info.height], [40, 80]);
assert.deepEqual([actual.width, actual.height, actual.orientation], [40, 80, undefined]);
const report = {
  scope: "Actual image processor and synthetic EXIF-rotated JPEG; no model or production call",
  input: { width: before.width, height: before.height, orientation: before.orientation },
  expectedDisplay: { width: expected.info.width, height: expected.info.height },
  actual: { width: actual.width, height: actual.height, orientation: actual.orientation ?? null },
};
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
