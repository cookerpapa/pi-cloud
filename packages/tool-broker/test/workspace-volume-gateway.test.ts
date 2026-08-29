import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("reattaches files without copying a per-Run Workspace snapshot", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");

    await expect(mover.prepare(first)).resolves.toEqual({ attached: false });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "answer.txt"), "one\n");
    await writeFile(join(workspace, "src", "answer.txt"), "two\n");

    const captured = await mover.snapshot({
      ...first,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    expect(captured.volumeRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.files).toEqual([
      expect.objectContaining({ path: "src/answer.txt", sizeBytes: 4 }),
    ]);

    const replacement = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const second = identity("session-b");
    await expect(replacement.prepare(second)).resolves.toEqual({ attached: true });
    const expectedSha256 = createHash("sha256").update("two\n").digest("hex");
    await expect(
      replacement.materialize({
        ...second,
        path: "src/answer.txt",
        expectedSha256,
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

  it("creates an idempotent isolated Volume copy that no longer follows the parent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const source = identity("session-parent");
    await mover.prepare(source);
    const sourceRoot = join(workspaceRoot, `picloud-posix-${source.volumeId}`, "workspace");
    await writeFile(join(sourceRoot, "answer.txt"), "parent-v1\n");
    const captured = await mover.snapshot({
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
      expectedSourceRevision: captured.volumeRevision,
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

  it("stores a user Git credential without cloning or exposing it to the Workspace index", async () => {
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
    const mover = new PersistentVolumeWorkspaceVolumeGateway({
      workspaceRoot,
      gitRunner: (args, options) => {
        if (options.credential !== undefined) observedTokens.push(options.credential.accessToken);
        const { credential: _credential, ...trustedOptions } = options;
        return runTrustedWorkspaceGit(
          args.map((argument) =>
            argument === "https://github.com/example/private-repo.git" ? remote : argument,
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
        userCloneUrl: "https://github.com/example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: false, reason: "credential_missing" });
    await expect(
      mover.authorizeSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        repositoryId: "90000000-0000-4000-8000-000000000001",
        provider: "github",
        userCloneUrl: "https://github.com/example/private-repo.git",
        credentialMountPath: "/workspace",
        accessToken: "ghs_process_scoped_secret",
      }),
    ).resolves.toEqual({ authorized: true });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${bound.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await expect(readdir(workspace)).resolves.toEqual([".pi-cloud-home"]);
    await expect(
      readFile(join(workspace, ".pi-cloud-home/.git-credentials"), "utf8"),
    ).resolves.toContain("ghs_process_scoped_secret");
    await expect(readFile(join(workspace, ".pi-cloud-home/.gitconfig"), "utf8")).resolves.toContain(
      "/workspace/.pi-cloud-home/.git-credentials",
    );
    await expect(
      mover.preflightSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        repositoryId: "90000000-0000-4000-8000-000000000001",
        provider: "github",
        userCloneUrl: "https://github.com/example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: true });
    const snapshot = await mover.snapshot({
      ...bound,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    expect(snapshot.files).toEqual([]);
    expect(observedTokens).toEqual(["ghs_process_scoped_secret"]);
  });
});

describe("HttpWorkspaceVolumeGateway", () => {
  it("transports a bounded large Workspace index without copying file bytes", async () => {
    const files = Array.from({ length: 3_500 }, (_, index) => ({
      path: `src/generated/file-${index.toString().padStart(5, "0")}.ts`,
      executable: false,
      sizeBytes: 16,
      sha256: index.toString(16).padStart(64, "0"),
    }));
    const gateway: WorkspaceVolumeGateway = {
      async checkHealth() {},
      async prepare() {
        return { attached: true };
      },
      async snapshot() {
        return {
          volumeRevision: "2".repeat(64),
          files,
        };
      },
      async fork() {
        return {
          sourceRevision: "2".repeat(64),
          volumeRevision: "3".repeat(64),
          files,
        };
      },
      async materialize() {
        return { bytes: new Uint8Array(), sha256: createHash("sha256").digest("hex") };
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
      const snapshot = await client.snapshot({
        ...identity("session-large-index"),
        activationId: randomUUID(),
        fencingToken: 1,
        bindingSha256: "3".repeat(64),
      });
      expect(snapshot.files).toHaveLength(files.length);
      await expect(client.delete(identity("session-large-index"))).resolves.toEqual({
        deleted: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
