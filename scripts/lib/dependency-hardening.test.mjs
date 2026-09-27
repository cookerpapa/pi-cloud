import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-hardening-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(
      fileURLToPath(new URL("../harden-pi-dependencies.mjs", import.meta.url)),
      join(root, "scripts/harden-pi-dependencies.mjs"),
    );
    const pkg = async (path, version, scope = "") => {
      await mkdir(join(root, scope, "node_modules", path), { recursive: true });
      await writeFile(
        join(root, scope, "node_modules", path, "package.json"),
        JSON.stringify({ version }),
      );
    };
    const invoke = (...args) =>
      spawnSync(process.execPath, [join(root, "scripts/harden-pi-dependencies.mjs"), ...args], {
        encoding: "utf8",
      });
    await run({ root, pkg, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(["", "packages/control-plane"])(
  "checks and prepares the API security dependency without Pi at %s",
  async (scope) => {
    await fixture(async ({ root, pkg, invoke }) => {
      await pkg("@nestjs/platform-fastify", "12.0.1", scope);
      await pkg("@nestjs/platform-fastify/node_modules/find-my-way", "9.6.0", scope);
      await pkg("platform-security-find-my-way", "9.7.0");
      expect(invoke("--check").status).not.toBe(0);
      expect(invoke().status).toBe(0);
      expect(invoke("--check").status).toBe(0);
      const actual = JSON.parse(
        await readFile(
          join(
            root,
            scope,
            "node_modules/@nestjs/platform-fastify/node_modules/find-my-way/package.json",
          ),
          "utf8",
        ),
      );
      expect(actual.version).toBe("9.7.0");
      await expect(
        access(join(root, "node_modules/@earendil-works/pi-coding-agent")),
      ).rejects.toThrow();
    });
  },
);

it("does not create security dependency trees for absent components", async () => {
  await fixture(async ({ root, invoke }) => {
    expect(invoke("--check").status).toBe(0);
    expect(invoke().status).toBe(0);
    await expect(access(join(root, "node_modules/@nestjs/platform-fastify"))).rejects.toThrow();
  });
});
