import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpWorkspaceVolumeGateway,
  PersistentVolumeWorkspaceVolumeGateway,
  WorkspaceVolumeGatewayServer,
  workspaceVolumeId,
  runTrustedWorkspaceGit,
  type WorkspaceVolumeGateway,
} from "../src/index.ts";

const roots: string[] = [];
const exec = promisify(execFile);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-cloud-volume-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function identity(sessionId: string) {
  const tenantId = "tenant-volume-test";
  const workspaceId = "workspace-volume-test";
  return {
    tenantId,
    workspaceId,
    sessionId,
    volumeId: workspaceVolumeId({ tenantId, workspaceId }),
  };
}

describe("PersistentVolumeWorkspaceVolumeGateway", () => {
  it("binds one durable volume to a Workspace across Sessions", () => {
    expect(identity("session-a").volumeId).toBe(identity("session-b").volumeId);
  });

  it("reattaches files while Run settlement records only a lightweight revision", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");

    await expect(mover.prepare(first)).resolves.toEqual({ attached: false });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "answer.txt"), "one\n");
    await writeFile(join(workspace, "src", "answer.txt"), "two\n");

    const captured = await mover.settle({
      ...first,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    expect(captured.settlementRevision).toMatch(/^[0-9a-f]{64}$/);

    const replacement = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const second = identity("session-b");
    await expect(replacement.prepare(second)).resolves.toEqual({ attached: true });
    const expectedSha256 = createHash("sha256").update("two\n").digest("hex");
    await expect(replacement.listDirectory({ ...second, rootPath: "", path: "" })).resolves.toEqual(
      {
        entries: [{ name: "src", path: "src", kind: "directory" }],
        truncated: false,
      },
    );
    await expect(
      replacement.listDirectory({ ...second, rootPath: "", path: "src" }),
    ).resolves.toMatchObject({
      entries: [{ path: "src/answer.txt", sizeBytes: 4 }],
    });
    await expect(
      replacement.readFile({
        ...second,
        rootPath: "",
        path: "src/answer.txt",
        maximumBytes: 64,
      }),
    ).resolves.toMatchObject({ sha256: expectedSha256 });
    await expect(readFile(join(workspace, "src", "answer.txt"), "utf8")).resolves.toBe("two\n");
  });

  it("binds the empty workspace directory created by the Cube Volume Plugin", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-created");
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await mkdir(join(volumeRoot, "workspace"), { recursive: true, mode: 0o700 });

    await expect(mover.prepare(first)).resolves.toEqual({ attached: false });
    await expect(mover.prepare(first)).resolves.toEqual({ attached: true });
  });

  it("hides platform and Git metadata and rejects a symlink escape", async () => {
    const workspaceRoot = await root();
    const outside = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-browser-boundary");
    await mover.prepare(first);
    const workspace = join(workspaceRoot, `picloud-posix-${first.volumeId}`, "workspace");
    await Promise.all([
      mkdir(join(workspace, ".git")),
      mkdir(join(workspace, ".pi-cloud-home")),
      writeFile(join(workspace, "visible.txt"), "visible\n"),
      writeFile(join(outside, "secret.txt"), "outside\n"),
    ]);
    await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));

    await expect(mover.listDirectory({ ...first, rootPath: "", path: "" })).resolves.toMatchObject({
      entries: [
        { name: "escape.txt", kind: "symlink" },
        { name: "visible.txt", kind: "file" },
      ],
    });
    await expect(
      mover.readFile({
        ...first,
        rootPath: "",
        path: "escape.txt",
        maximumBytes: 64,
      }),
    ).rejects.toMatchObject({ code: "workspace_path_escape" });
  });

  it("creates an idempotent isolated Volume copy that no longer follows the parent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const source = identity("session-parent");
    await mover.prepare(source);
    const sourceRoot = join(workspaceRoot, `picloud-posix-${source.volumeId}`, "workspace");
    await writeFile(join(sourceRoot, "answer.txt"), "parent-v1\n");
    const captured = await mover.settle({
      ...source,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    const target = {
      tenantId: source.tenantId,
      workspaceId: "workspace-volume-isolated",
      sessionId: "session-child",
      volumeId: workspaceVolumeId({
        tenantId: source.tenantId,
        workspaceId: "workspace-volume-isolated",
      }),
    };
    await mkdir(join(workspaceRoot, `picloud-posix-${target.volumeId}`, "workspace"), {
      recursive: true,
    });
    const request = {
      tenantId: source.tenantId,
      sourceWorkspaceId: source.workspaceId,
      sourceSessionId: source.sessionId,
      sourceVolumeId: source.volumeId,
      expectedSourceSettlementRevision: captured.settlementRevision,
      targetWorkspaceId: target.workspaceId,
      targetSessionId: target.sessionId,
      targetVolumeId: target.volumeId,
    };
    const first = await mover.fork(request);
    await writeFile(join(sourceRoot, "answer.txt"), "parent-v2\n");
    await expect(mover.fork(request)).resolves.toEqual(first);
    await expect(
      readFile(
        join(workspaceRoot, `picloud-posix-${target.volumeId}`, "workspace", "answer.txt"),
        "utf8",
      ),
    ).resolves.toBe("parent-v1\n");
  });

  it("rejects an unbound Cube workspace that already contains user bytes", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-nonempty");
    const workspace = join(workspaceRoot, `picloud-posix-${first.volumeId}`, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "untrusted.txt"), "not pristine\n");

    await expect(mover.prepare(first)).rejects.toMatchObject({
      code: "workspace_volume_binding_invalid",
    });
  });

  it("rejects a volume identity from another tenant", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");
    await mover.prepare(first);
    await expect(mover.prepare({ ...first, tenantId: "tenant-other" })).rejects.toMatchObject({
      code: "workspace_data_binding_invalid",
    });
  });

  it("deletes only the persistently bound Workspace volume and is idempotent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-delete");
    await mover.prepare(first);
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await writeFile(join(volumeRoot, "workspace", "private.txt"), "delete me\n");

    await expect(mover.delete(first)).resolves.toEqual({ deleted: true });
    await expect(lstat(volumeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(mover.delete(first)).resolves.toEqual({ deleted: false });
  });

  it("stores and revalidates a Git-normalized credential outside the product browser", async () => {
    const workspaceRoot = await root();
    const fixtureRoot = await root();
    const remote = join(fixtureRoot, "remote.git");
    const seed = join(fixtureRoot, "seed");
    await exec("/usr/bin/git", ["init", "--bare", remote]);
    await mkdir(seed);
    await exec("/usr/bin/git", ["init"], { cwd: seed });
    await exec("/usr/bin/git", ["config", "user.name", "Test"], { cwd: seed });
    await exec("/usr/bin/git", ["config", "user.email", "test@example.com"], { cwd: seed });
    await writeFile(join(seed, "README.md"), "private source\n");
    await exec("/usr/bin/git", ["add", "README.md"], { cwd: seed });
    await exec("/usr/bin/git", ["commit", "-m", "initial"], { cwd: seed });
    await exec("/usr/bin/git", ["branch", "-M", "main"], { cwd: seed });
    await exec("/usr/bin/git", ["remote", "add", "origin", remote], { cwd: seed });
    await exec("/usr/bin/git", ["push", "origin", "main"], { cwd: seed });

    const observedTokens: string[] = [];
    const observedVerificationUrls: string[] = [];
    const mover = new PersistentVolumeWorkspaceVolumeGateway({
      workspaceRoot,
      gitRunner: (args, options) => {
        if (options.credential !== undefined) observedTokens.push(options.credential.accessToken);
        if (args[0] === "ls-remote" && args[1] !== undefined) {
          observedVerificationUrls.push(args[1]);
        }
        const { credential: _credential, ...trustedOptions } = options;
        return runTrustedWorkspaceGit(
          args.map((argument) =>
            argument === "https://git.internal.example/private-repo.git" ? remote : argument,
          ),
          trustedOptions,
        );
      },
    });
    const bound = identity("source-control-request");
    await mover.prepare(bound);
    await expect(
      mover.preflightSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        repositoryId: "90000000-0000-4000-8000-000000000001",
        provider: "github",
        userCloneUrl: "https://github.com:8443/example/private-repo.git",
        verificationCloneUrl: "https://git.internal.example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: false, reason: "credential_missing" });
    await expect(
      mover.authorizeSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        repositoryId: "90000000-0000-4000-8000-000000000001",
        provider: "github",
        userCloneUrl: "https://github.com:8443/example/private-repo.git",
        verificationCloneUrl: "https://git.internal.example/private-repo.git",
        credentialMountPath: "/workspace",
        accessToken: "ghs_process_scoped_secret",
      }),
    ).resolves.toEqual({ authorized: true });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${bound.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await expect(readdir(workspace)).resolves.toEqual([".pi-cloud-home"]);
    const credentialPath = join(workspace, ".pi-cloud-home/.git-credentials");
    const storedCredential = await readFile(credentialPath, "utf8");
    expect(storedCredential).toContain("ghs_process_scoped_secret");
    await writeFile(credentialPath, storedCredential.replace(":8443", "%3a8443"));
    await expect(readFile(join(workspace, ".pi-cloud-home/.gitconfig"), "utf8")).resolves.toContain(
      "/workspace/.pi-cloud-home/.git-credentials",
    );
    await expect(
      mover.preflightSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        repositoryId: "90000000-0000-4000-8000-000000000001",
        provider: "github",
        userCloneUrl: "https://github.com:8443/example/private-repo.git",
        verificationCloneUrl: "https://git.internal.example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: true });
    const settlement = await mover.settle({
      ...bound,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    expect(settlement.settlementRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(observedTokens).toEqual(["ghs_process_scoped_secret"]);
    expect(observedVerificationUrls).toEqual(["https://git.internal.example/private-repo.git"]);
  });
});

describe("HttpWorkspaceVolumeGateway", () => {
  it("transports a bounded current directory without a precomputed catalog", async () => {
    const entries = Array.from({ length: 3_500 }, (_, index) => ({
      name: `file-${index.toString().padStart(5, "0")}.ts`,
      path: `src/file-${index.toString().padStart(5, "0")}.ts`,
      kind: "file" as const,
      sizeBytes: 16,
      executable: false,
    }));
    const gateway: WorkspaceVolumeGateway = {
      async checkHealth() {},
      async prepare() {
        return { attached: true };
      },
      async settle() {
        return { settlementRevision: "2".repeat(64) };
      },
      async fork() {
        return {
          sourceSettlementRevision: "2".repeat(64),
          targetSettlementRevision: "3".repeat(64),
        };
      },
      async listDirectory() {
        return { entries, truncated: false };
      },
      async readFile() {
        return {
          bytes: Buffer.from("current\n"),
          sha256: createHash("sha256").update("current\n").digest("hex"),
          executable: false,
        };
      },
      async delete() {
        return { deleted: true };
      },
      async close() {},
    };
    const serviceToken = "v".repeat(48);
    const server = new WorkspaceVolumeGatewayServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      gateway,
    });
    const address = await server.listen();
    const client = new HttpWorkspaceVolumeGateway({ baseUrl: address, serviceToken });
    try {
      const settlement = await client.settle({
        ...identity("session-large-index"),
        activationId: randomUUID(),
        fencingToken: 1,
        bindingSha256: "3".repeat(64),
      });
      expect(settlement.settlementRevision).toBe("2".repeat(64));
      await expect(
        client.listDirectory({ ...identity("session-large-index"), rootPath: "", path: "src" }),
      ).resolves.toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ path: "src/file-00000.ts" })]),
      });
      await expect(client.delete(identity("session-large-index"))).resolves.toEqual({
        deleted: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
