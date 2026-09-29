import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_USER_UPLOAD_BYTES } from "@pi-cloud/protocol/guest";
import { prepareInputFile } from "./input-files.ts";

async function main() {
  const path = process.argv[2];
  if (!path || !/^\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json$/.test(path))
    throw new Error("Invalid input envelope");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > Math.ceil(MAX_USER_UPLOAD_BYTES / 3) * 4 + 8192)
      throw new Error("Input envelope exceeds its limit");
    value = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  return prepareInputFile(value);
}
void main().then(
  (result) => {
    process.stdout.write(JSON.stringify({ ok: true, result }));
  },
  () => {
    process.stdout.write(JSON.stringify({ ok: false, code: "input_file_preparation_failed" }));
  },
);
