import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("runs the real selective-import entrypoint with an empty plan and rejects outside references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pma-import-cli-"));
  try {
    await mkdir(join(root, "k3s"));
    await writeFile(join(root, ".env"), "");
    const catalog = join(root, "k3s/images.json");
    await writeFile(catalog, JSON.stringify({ controlPlane: "pi-cloud/control-plane:owned" }));
    const args = [
      fileURLToPath(new URL("../production-kubernetes.mjs", import.meta.url)),
      "import-images",
      "--only",
    ];
    const options = {
      env: { ...process.env, PI_CLOUD_RUNTIME_DIRECTORY: root, PI_CLOUD_IMAGE_CATALOG: catalog },
      timeout: 10_000,
    };
    await expect(promisify(execFile)(process.execPath, args, options)).resolves.toMatchObject({
      stdout: "",
    });
    await expect(
      promisify(execFile)(process.execPath, [...args, "pi-cloud/control-plane:unowned"], options),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Image import is outside the candidate catalog"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
