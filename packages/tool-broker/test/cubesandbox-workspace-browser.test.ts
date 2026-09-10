import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { browseCubeWorkspace } from "../src/cubesandbox-workspace-browser.ts";
import type {
  CubeSandboxRuntimeClient,
  CubeSandboxInstance,
} from "../src/cubesandbox-runtime-client.ts";

it("lists surviving files if a background process removes an entry during enumeration", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-browser-race-"));
  const vanished = join(root, "vanished.tmp");
  const require = createRequire(import.meta.url);
  const client = {
    runCommand: async (_instance, input) => {
      const args = [...input.command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
      let stdout = "";
      runInNewContext(Buffer.from(args[1]!, "base64").toString(), {
        Buffer,
        process: {
          argv: ["node", "test", args[2]],
          stdout: {
            write: (text: string) => {
              stdout += text;
            },
          },
        },
        require: (name: string) =>
          name === "node:fs"
            ? {
                ...fs,
                lstatSync: (path: string) => {
                  if (path === vanished) fs.unlinkSync(path);
                  return fs.lstatSync(path);
                },
              }
            : require(name),
      });
      return { stdout, stderr: "", exitCode: 0 };
    },
  } as CubeSandboxRuntimeClient;
  try {
    await writeFile(vanished, "gone");
    await writeFile(join(root, "code.py"), "print(42)");
    await expect(
      browseCubeWorkspace(client, {} as CubeSandboxInstance, {
        toolBrokerProtocolVersion: 1,
        type: "workspace.list_directory",
        requestId: crypto.randomUUID(),
        tenantId: "t",
        workspaceId: "w",
        sessionId: "s",
        rootPath: "",
        path: "",
        machine: {
          environmentId: crypto.randomUUID(),
          userId: crypto.randomUUID(),
          directory: root,
        },
      }),
    ).resolves.toMatchObject({ entries: [{ name: "code.py", kind: "file" }], truncated: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads code outside /home/user with bounded output and does not follow escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-browser-"));
  const exec = promisify(execFile);
  const client = {
    runCommand: async (_instance, input) => {
      const output = await exec("bash", [
        "-c",
        input.command.replace("/usr/local/bin/node", process.execPath),
      ]);
      return { ...output, exitCode: 0 };
    },
  } as CubeSandboxRuntimeClient;
  const instance = {} as CubeSandboxInstance;
  const request = {
    toolBrokerProtocolVersion: 1 as const,
    type: "workspace.list_directory" as const,
    requestId: crypto.randomUUID(),
    tenantId: "tenant",
    workspaceId: "workspace",
    sessionId: "session",
    rootPath: "",
    path: "",
    machine: {
      environmentId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      directory: join(root, "project"),
    },
  };
  try {
    await mkdir(request.machine.directory);
    await writeFile(join(root, "canary"), "outside");
    await writeFile(join(request.machine.directory, "code.py"), "print(42)\n");
    await symlink(join(root, "canary"), join(request.machine.directory, "escape"));
    const listing = await browseCubeWorkspace(client, instance, request);
    expect(listing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "code.py", kind: "file" }),
        expect.objectContaining({ name: "escape", kind: "symlink" }),
      ]),
    );
    const read = {
      ...request,
      type: "workspace.read_file" as const,
      path: "code.py",
      maximumBytes: 100,
    };
    expect(await browseCubeWorkspace(client, instance, read)).toMatchObject({
      content: Buffer.from("print(42)\n").toString("base64"),
      sizeBytes: 10,
    });
    await expect(
      browseCubeWorkspace(client, instance, { ...read, path: "escape" }),
    ).rejects.toBeDefined();
    await expect(
      browseCubeWorkspace(client, instance, { ...read, maximumBytes: 2 }),
    ).rejects.toBeDefined();
    await expect(
      browseCubeWorkspace(client, instance, { ...read, path: "../canary" }),
    ).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
