import { createPluginVolumeFixture } from "./fixtures/plugin-volume.ts";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fileSystem from "node:fs/promises";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => Reflect.apply(actual.lstat, actual, args),
    open: (...args: Parameters<typeof actual.open>) => Reflect.apply(actual.open, actual, args),
    readdir: (...args: Parameters<typeof actual.readdir>) =>
      Reflect.apply(actual.readdir, actual, args),
  };
});
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
  it("rejects another Volume's identity even at the requested storage path", async () => {
    const workspaceRoot = await root();
    const gateway = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const input = identity("swapped-volume");
    const other = { ...input, workspaceId: "other-workspace" };
    other.volumeId = workspaceVolumeId(other);
    await createPluginVolumeFixture(workspaceRoot, other);
    await rename(
      join(workspaceRoot, `picloud-posix-${other.volumeId}`),
      join(workspaceRoot, `picloud-posix-${input.volumeId}`),
    );
    await expect(gateway.verify(input)).rejects.toMatchObject({
      code: "workspace_volume_binding_invalid",
    });
  });

  it("never creates or repairs storage while verifying an unpublished plugin identity", async () => {
    const workspaceRoot = await root();
    const gateway = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const input = identity("verification-only");
    await expect(gateway.verify(input)).rejects.toMatchObject({
      code: "workspace_volume_identity_unavailable",
    });
    expect(await readdir(workspaceRoot)).toEqual([]);
    const workspace = join(workspaceRoot, `picloud-posix-${input.volumeId}`, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "keep.txt"), "existing data");
    await expect(gateway.verify(input)).rejects.toMatchObject({
      code: "workspace_volume_identity_unavailable",
    });
    expect(await readdir(join(workspace, ".."))).toEqual(["workspace"]);
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("existing data");
  });

  it("does not hold the Volume lock while waiting for a remote credential probe", async () => {
    const workspaceRoot = await root();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mover = new PersistentVolumeWorkspaceVolumeGateway({
      workspaceRoot,
      gitRunner: async () => {
        entered();
        await blocked;
        return { stdout: "", exitCode: 0 };
      },
    });
    const scope = identity("nonblocking-credential-probe");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    await mover.authorizeSourceCredential({
      ...scope,
      requestId: randomUUID(),
      provider: "gitlab",
      origin: "https://gitlab.invalid",
      credentialMountPath: "/workspace",
      accessToken: "test-probe-token",
    });
    const probe = mover.preflightSourceCredential({
      ...scope,
      requestId: randomUUID(),
      provider: "gitlab",
      origin: "https://gitlab.invalid",
      credentialMountPath: "/workspace",
      verificationCloneUrl: "https://gitlab.invalid/repo.git",
    });
    let listing: Promise<unknown> | undefined;
    try {
      await started;
      let listed = false;
      listing = mover.listDirectory({ ...scope, rootPath: "", path: "" }).then(() => {
        listed = true;
      });
      await vi.waitFor(() => expect(listed).toBe(true), { timeout: 300 });
    } finally {
      release();
      await probe;
      await listing;
      await mover.close();
    }
  });

  it("enforces the read limit if a regular file grows after its stat", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("growing-file");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const target = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace", "code.txt");
    await writeFile(target, "small");
    const original = fileSystem.open;
    const opening = vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
      const file = await Reflect.apply(original, fileSystem, args);
      if (String(args[0]) === target) {
        const stat = file.stat.bind(file);
        file.stat = (async () => {
          const result = await stat();
          await writeFile(target, "x".repeat(128));
          return result;
        }) as typeof file.stat;
      }
      return file;
    });
    try {
      await expect(
        mover.readFile({ ...scope, rootPath: "", path: "code.txt", maximumBytes: 64 }),
      ).rejects.toMatchObject({ code: "workspace_file_invalid" });
    } finally {
      opening.mockRestore();
      await mover.close();
    }
  });

  it("rejects a parent-directory swap between path validation and opening a file", async () => {
    const workspaceRoot = await root(),
      outside = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("file-parent-race");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const workspace = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
    const directory = join(workspace, "src"),
      target = join(directory, "code.txt");
    await mkdir(directory);
    await writeFile(target, "own code");
    await writeFile(join(outside, "code.txt"), "outside fixture content");
    const original = fileSystem.open;
    let swapped = false;
    const opening = vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === target && !swapped) {
        swapped = true;
        await rename(directory, `${directory}-old`);
        await symlink(outside, directory);
      }
      return Reflect.apply(original, fileSystem, args);
    });
    try {
      await expect(
        mover.readFile({ ...scope, rootPath: "", path: "src/code.txt", maximumBytes: 64 }),
      ).rejects.toMatchObject({ code: "workspace_path_escape" });
      expect(swapped).toBe(true);
    } finally {
      opening.mockRestore();
      await mover.close();
    }
  });

  it("lists the opened directory, not a replacement symlink installed during readdir", async () => {
    const workspaceRoot = await root(),
      outside = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("directory-parent-race");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const workspace = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
    const directory = join(workspace, "src");
    await mkdir(directory);
    await writeFile(join(directory, "own.txt"), "own");
    await writeFile(join(outside, "outside.txt"), "other fixture");
    const original = fileSystem.readdir;
    let swapped = false;
    const listing = vi.spyOn(fileSystem, "readdir").mockImplementation(async (...args) => {
      if (
        !swapped &&
        (String(args[0]) === directory || String(args[0]).startsWith("/proc/self/fd/"))
      ) {
        swapped = true;
        await rename(directory, `${directory}-old`);
        await symlink(outside, directory);
      }
      return Reflect.apply(original, fileSystem, args);
    });
    try {
      await expect(
        mover.listDirectory({ ...scope, rootPath: "", path: "src" }),
      ).resolves.toMatchObject({ entries: [{ name: "own.txt" }] });
      expect(swapped).toBe(true);
    } finally {
      listing.mockRestore();
      await mover.close();
    }
  });

  it("does not execute Workspace Git configuration during trusted credential preflight", async () => {
    const workspaceRoot = await root();
    const fixture = await root();
    const marker = join(fixture, "workspace-config-executed");
    const helper = join(fixture, "fake-ssh");
    await writeFile(helper, `#!/bin/sh\n: > '${marker}'\nexit 1\n`, { mode: 0o700 });
    let requests = 0;
    const http = createServer((_request, response) => {
      requests++;
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("untrusted-git-config");
    try {
      await createPluginVolumeFixture(workspaceRoot, scope);
      await mover.verify(scope);
      const workspace = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
      await exec("/usr/bin/git", ["init"], { cwd: workspace });
      await exec("/usr/bin/git", ["config", "core.sshCommand", helper], { cwd: workspace });
      await exec("/usr/bin/git", ["config", "url.ssh://fake-host/.insteadOf", `${origin}/`], {
        cwd: workspace,
      });
      await mover.authorizeSourceCredential({
        ...scope,
        requestId: randomUUID(),
        provider: "gitlab",
        origin,
        credentialMountPath: "/workspace",
        accessToken: "test-preflight-credential",
      });
      await expect(
        mover.preflightSourceCredential({
          ...scope,
          requestId: randomUUID(),
          provider: "gitlab",
          origin,
          credentialMountPath: "/workspace",
          verificationCloneUrl: `${origin}/repo.git`,
        }),
      ).resolves.toMatchObject({ authorized: false });
      await expect.soft(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requests).toBeGreaterThan(0);
    } finally {
      await mover.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not follow a Workspace credential symlink outside its volume", async () => {
    const workspaceRoot = await root(),
      outside = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("credential-symlink");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const credential = join(outside, "fixture-credentials");
    await writeFile(credential, "https://oauth2:owned-test-token@gitlab.invalid/\n");
    const workspace = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
    await symlink(credential, join(workspace, ".git-credentials"));
    await expect(
      mover.listSourceCredentials({
        ...scope,
        requestId: randomUUID(),
        credentialMountPath: "/workspace",
      }),
    ).rejects.toBeDefined();
    await mover.close();
  });

  it("does not fail the whole directory when a concurrently deleted file disappears", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const scope = identity("directory-race");
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const directory = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
    const vanished = join(directory, "vanished.tmp");
    await writeFile(vanished, "gone");
    await writeFile(join(directory, "code.py"), "print(42)");
    const original = fileSystem.lstat;
    const inspect = vi.spyOn(fileSystem, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/vanished.tmp")) await rm(vanished);
      return Reflect.apply(original, fileSystem, args);
    });
    try {
      await expect(
        mover.listDirectory({ ...scope, rootPath: "", path: "" }),
      ).resolves.toMatchObject({
        entries: [{ name: "code.py", kind: "file" }],
        truncated: false,
      });
    } finally {
      inspect.mockRestore();
      await mover.close();
    }
  });
  it("browses an unmaterialized root without creating storage", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    await expect(
      mover.listDirectory({ ...identity("empty"), rootPath: "", path: "" }),
    ).resolves.toEqual({ entries: [], truncated: false });
    expect(await readdir(workspaceRoot)).toEqual([]);
    await expect(
      mover.listDirectory({ ...identity("empty"), rootPath: "", path: "missing" }),
    ).rejects.toMatchObject({ retryable: false });
    await mover.close();
  });

  it("binds one durable volume to a Workspace across Sessions", () => {
    expect(identity("session-a").volumeId).toBe(identity("session-b").volumeId);
  });

  it("validates explicit task directories through the HTTP browser, including long paths and symlink escape", async () => {
    const workspaceRoot = await root(),
      outside = await root();
    const scope = identity("subagent-directory");
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    await createPluginVolumeFixture(workspaceRoot, scope);
    await mover.verify(scope);
    const workspace = join(workspaceRoot, `picloud-posix-${scope.volumeId}`, "workspace");
    const path = Array.from({ length: 6 }, (_, i) => `task-${i}-${"x".repeat(90)}`).join("/");
    await mkdir(join(workspace, path), { recursive: true });
    await symlink(outside, join(workspace, "escape"));
    const token = "directory-contract-" + "x".repeat(32);
    const server = new WorkspaceVolumeGatewayServer({
      gateway: mover,
      serviceToken: token,
      host: "127.0.0.1",
      port: 0,
    });
    const address = await server.listen();
    const client = new HttpWorkspaceVolumeGateway({ baseUrl: address, serviceToken: token });
    try {
      await expect(client.listDirectory({ ...scope, rootPath: "", path })).resolves.toEqual({
        entries: [],
        truncated: false,
      });
      for (const invalid of ["missing", "escape", "../escape"]) {
        await expect(
          client.listDirectory({ ...scope, rootPath: "", path: invalid }),
        ).rejects.toMatchObject({ retryable: false });
      }
      await expect(
        client.readFile({ ...scope, rootPath: "", path: "missing.txt", maximumBytes: 32 }),
      ).rejects.toMatchObject({ code: "workspace_path_unavailable", retryable: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reattaches current files without a per-Run settlement", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");

    await createPluginVolumeFixture(workspaceRoot, first);
    await expect(mover.verify(first)).resolves.toEqual({ verified: true });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "answer.txt"), "one\n");
    await writeFile(join(workspace, "src", "answer.txt"), "two\n");

    const replacement = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const second = identity("session-b");
    await expect(replacement.verify(second)).resolves.toEqual({ verified: true });
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

  it("verifies the identity and directory created by the Cube Volume Plugin", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-created");
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await mkdir(join(volumeRoot, "workspace"), { recursive: true, mode: 0o700 });

    await createPluginVolumeFixture(workspaceRoot, first);
    await expect(mover.verify(first)).resolves.toEqual({ verified: true });
    await expect(mover.verify(first)).resolves.toEqual({ verified: true });
  });

  it("hides platform and Git metadata and rejects a symlink escape", async () => {
    const workspaceRoot = await root();
    const outside = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-browser-boundary");
    await createPluginVolumeFixture(workspaceRoot, first);
    await mover.verify(first);
    const workspace = join(workspaceRoot, `picloud-posix-${first.volumeId}`, "workspace");
    await Promise.all([
      mkdir(join(workspace, ".git")),
      writeFile(join(workspace, ".git-credentials"), "hidden\n"),
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

  it("rejects an unbound Cube workspace that already contains user bytes", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-nonempty");
    const workspace = join(workspaceRoot, `picloud-posix-${first.volumeId}`, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "untrusted.txt"), "not pristine\n");

    await expect(mover.verify(first)).rejects.toMatchObject({
      code: "workspace_volume_identity_unavailable",
    });
  });

  it("rejects a volume identity from another tenant", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");
    await createPluginVolumeFixture(workspaceRoot, first);
    await mover.verify(first);
    await expect(mover.verify({ ...first, tenantId: "tenant-other" })).rejects.toMatchObject({
      code: "workspace_data_binding_invalid",
    });
  });

  it("deletes only the persistently bound Workspace volume and is idempotent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-delete");
    await createPluginVolumeFixture(workspaceRoot, first);
    await mover.verify(first);
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await writeFile(join(volumeRoot, "workspace", "private.txt"), "delete me\n");

    await expect(mover.prepareDelete(first)).resolves.toEqual({ prepared: true });
    await expect(mover.verify(first)).rejects.toMatchObject({ code: "workspace_volume_deleting" });
    await expect(mover.finalizeDelete(first)).rejects.toMatchObject({
      code: "workspace_volume_delete_pending",
    });
    await expect(readFile(join(volumeRoot, "workspace", "private.txt"), "utf8")).resolves.toBe(
      "delete me\n",
    );
    await expect(mover.prepareDelete(first)).resolves.toEqual({ prepared: true });
    // Cube's Controller hook removes user bytes; the gateway removes metadata.
    await rm(join(volumeRoot, "workspace"), { recursive: true });
    await expect(mover.finalizeDelete(first)).resolves.toEqual({ deleted: true });
    await expect(lstat(volumeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(mover.finalizeDelete(first)).resolves.toEqual({ deleted: false });
    await expect(mover.prepareDelete(first)).resolves.toEqual({ prepared: false });
  });

  it("finishes a metadata-retirement crash without recreating a deleted Volume", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const input = identity("retired-metadata");
    const directory = join(workspaceRoot, `picloud-posix-${input.volumeId}`);
    await createPluginVolumeFixture(workspaceRoot, input);
    await mover.verify(input);
    await mover.prepareDelete(input);
    await rm(join(directory, "workspace"), { recursive: true });
    await rename(directory, `${directory}.deleted`);
    await expect(
      mover.readFile({ ...input, rootPath: "", path: "no-file", maximumBytes: 100 }),
    ).rejects.toBeDefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(mover.prepareDelete(input)).resolves.toEqual({ prepared: false });
    await expect(mover.finalizeDelete(input)).resolves.toEqual({ deleted: false });
    await expect(lstat(`${directory}.deleted`)).rejects.toMatchObject({ code: "ENOENT" });
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
    await createPluginVolumeFixture(workspaceRoot, bound);
    await mover.verify(bound);
    await expect(
      mover.preflightSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        provider: "github",
        origin: "https://github.com:8443",
        verificationCloneUrl: "https://git.internal.example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: false, reason: "credential_missing" });
    await expect(
      mover.authorizeSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        provider: "github",
        origin: "https://github.com:8443",
        credentialMountPath: "/workspace",
        accessToken: "ghs_process_scoped_secret",
      }),
    ).resolves.toEqual({ authorized: true });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${bound.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await expect(readdir(workspace)).resolves.toEqual([".git-credentials"]);
    const credentialPath = join(workspace, ".git-credentials");
    const storedCredential = await readFile(credentialPath, "utf8");
    expect(storedCredential).toContain("ghs_process_scoped_secret");
    await writeFile(credentialPath, storedCredential.replace(":8443", "%3a8443"));
    await expect(
      mover.preflightSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        provider: "github",
        origin: "https://github.com:8443",
        verificationCloneUrl: "https://git.internal.example/private-repo.git",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ authorized: true });
    await mover.authorizeSourceCredential!({
      ...bound,
      requestId: randomUUID(),
      provider: "gitlab",
      origin: "https://gitlab.example.com",
      credentialMountPath: "/workspace",
      accessToken: "glpat_second_site_secret",
    });
    await expect(readFile(credentialPath, "utf8")).resolves.toEqual(
      expect.stringContaining("ghs_process_scoped_secret"),
    );
    await expect(readFile(credentialPath, "utf8")).resolves.toEqual(
      expect.stringContaining("glpat_second_site_secret"),
    );
    await expect(
      mover.listSourceCredentials!({
        ...bound,
        requestId: randomUUID(),
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({
      connections: [
        { provider: "github", origin: "https://github.com:8443" },
        { provider: "gitlab", origin: "https://gitlab.example.com" },
      ],
    });
    await expect(
      mover.disconnectSourceCredential!({
        ...bound,
        requestId: randomUUID(),
        provider: "gitlab",
        origin: "https://gitlab.example.com",
        credentialMountPath: "/workspace",
      }),
    ).resolves.toEqual({ disconnected: true });
    await expect(readFile(credentialPath, "utf8")).resolves.not.toContain(
      "glpat_second_site_secret",
    );
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
      async verify() {
        return { verified: true };
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
      async prepareDelete() {
        return { prepared: true };
      },
      async finalizeDelete() {
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
      await expect(
        client.listDirectory({ ...identity("session-large-index"), rootPath: "", path: "src" }),
      ).resolves.toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ path: "src/file-00000.ts" })]),
      });
      await expect(client.prepareDelete(identity("session-large-index"))).resolves.toEqual({
        prepared: true,
      });
      await expect(client.finalizeDelete(identity("session-large-index"))).resolves.toEqual({
        deleted: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
