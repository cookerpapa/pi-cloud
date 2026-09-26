import { mkdtemp, mkdir, writeFile, chmod, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { guestBuildIdentity, guestCopyInputs } from "./guest-build-identity.mjs";

it("includes explicit guest inputs, modes and links while ignoring unrelated UI/docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-guest-build-"));
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "deploy/cubesandbox/Dockerfile.tool"),
      "FROM example@sha256:fixture\nCOPY src /app\nCOPY --from=builder /out /bin\n",
    );
    await writeFile(join(root, "src/tool.sh"), "echo fixture\n", { mode: 0o644 });
    const first = await guestBuildIdentity(root);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(root, "README.md"), "unrelated docs");
    await writeFile(join(root, "frontend.ts"), "unrelated UI");
    expect(await guestBuildIdentity(root)).toBe(first);
    await chmod(join(root, "src/tool.sh"), 0o755);
    expect(await guestBuildIdentity(root)).not.toBe(first);
    await chmod(join(root, "src/tool.sh"), 0o644);
    await writeFile(join(root, "src/tool.sh"), "echo changed\n");
    expect(await guestBuildIdentity(root)).not.toBe(first);
    await symlink("tool.sh", join(root, "src/link"));
    const linked = await guestBuildIdentity(root);
    await unlink(join(root, "src/link"));
    await symlink("../README.md", join(root, "src/link"));
    expect(await guestBuildIdentity(root)).not.toBe(linked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recognizes multi-line COPY and rejects implicit build-context scans", () => {
  expect(guestCopyInputs("COPY --chown=1000:1000 \\\n  a b \\\n  /destination\n")).toEqual([
    "a",
    "b",
    "deploy/cubesandbox/Dockerfile.tool",
  ]);
  expect(() => guestCopyInputs("COPY . /app")).toThrow("explicit local inputs");
  expect(() => guestCopyInputs("COPY src/* /app")).toThrow("explicit local inputs");
});
