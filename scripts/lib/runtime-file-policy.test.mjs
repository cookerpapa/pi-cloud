import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readPrivateRuntimeFile,
  runtimeSecretMode,
  unsafeRuntimeFileMode,
} from "./runtime-file-policy.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("permits only the selected trusted-reader Secrets through the operator group", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-secret-mode-"));
  roots.push(root);
  for (const name of [
    "database-url",
    "workspace-volume-gateway-token",
    "metrics-token",
    "api-token",
    ".env",
  ]) {
    const path = join(root, name);
    await writeFile(path, "fixture-secret", { mode: 0o600 });
    await expect(readPrivateRuntimeFile(path, 128, "Fixture")).resolves.toBe("fixture-secret");
    await chmod(path, 0o640);
    if (runtimeSecretMode(name) === 0o640)
      await expect(readPrivateRuntimeFile(path, 128, "Fixture")).resolves.toBe("fixture-secret");
    else await expect(readPrivateRuntimeFile(path, 128, "Fixture")).rejects.toThrow("private");
    await chmod(path, 0o644);
    await expect(readPrivateRuntimeFile(path, 128, "Fixture")).rejects.toThrow("private");
  }
});
it("requires reader group membership except for the root administrator", () => {
  expect(unsafeRuntimeFileMode({ mode: 0o640, gid: 2147483646 }, "database-url")).toBe(
    process.geteuid?.() !== 0,
  );
});
it("rejects symlinks, empty and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-secret-bounds-"));
  roots.push(root);
  const path = join(root, "api-token");
  await writeFile(path, "", { mode: 0o600 });
  await expect(readPrivateRuntimeFile(path, 16, "Fixture")).rejects.toThrow("bounded");
  await writeFile(path, "x".repeat(17));
  await expect(readPrivateRuntimeFile(path, 16, "Fixture")).rejects.toThrow("bounded");
  const link = join(root, "linked");
  await symlink(path, link);
  await expect(readPrivateRuntimeFile(link, 128, "Fixture")).rejects.toThrow();
});
