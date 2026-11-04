import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["early", "workspace", "original", "source_error"])(
  "settles the active original or placement transport without an unhandled stream error (%s)",
  async (mode) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/upload-abort.mjs", import.meta.url)),
        mode,
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    expect(result.stdout).toContain("owned_upload_abort_settled");
  },
);
