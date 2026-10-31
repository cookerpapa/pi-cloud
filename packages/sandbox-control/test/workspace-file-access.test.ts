import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  SandboxControlListWorkspaceDirectoryRequest,
  SandboxControlReadWorkspaceFileRequest,
  SandboxControlReadWorkspaceFileResponse,
  WorkspaceUploadRequest,
} from "@pi-cloud/protocol";
import {
  SandboxControlError,
  type SandboxHandle,
  type SandboxWorkspaceFiles,
} from "../src/sandbox-provider.ts";
import { WorkspaceFileAccess, type WorkspaceFileAdmission } from "../src/workspace-file-access.ts";

const identity = {
  requestId: randomUUID(),
  tenantId: randomUUID(),
  workspaceId: randomUUID(),
  sessionId: randomUUID(),
  rootPath: "",
  path: "source.ts",
  toolBrokerProtocolVersion: 1 as const,
};
const read: SandboxControlReadWorkspaceFileRequest = {
  ...identity,
  type: "workspace.read_file",
  maximumBytes: 512,
};
const list: SandboxControlListWorkspaceDirectoryRequest = {
  ...identity,
  type: "workspace.list_directory",
};
const response: SandboxControlReadWorkspaceFileResponse = {
  toolBrokerProtocolVersion: 1,
  type: "workspace.file_read",
  requestId: read.requestId,
  tenantId: read.tenantId,
  workspaceId: read.workspaceId,
  path: read.path,
  content: "c291cmNl",
  sha256: "a".repeat(64),
  executable: false,
  sizeBytes: 6,
};
const upload: WorkspaceUploadRequest = {
  uploadProtocolVersion: 2,
  type: "workspace.upload_file",
  byteLength: 6,
  requestId: randomUUID(),
  uploadId: randomUUID(),
  claimToken: randomUUID(),
  tenantId: identity.tenantId,
  sessionId: identity.sessionId,
  workspaceId: identity.workspaceId,
  rootPath: "",
  name: "source.ts",
  sha256: "a".repeat(64),
};
const machine = { environmentId: randomUUID(), userId: randomUUID(), directory: "/home/user" };
// The file adapter passes the owner's handle through without interpreting or adopting it.
const handle = Object.freeze({ runtimeId: "already-owned-machine" }) as SandboxHandle;
function admission(): WorkspaceFileAdmission {
  return { machine: vi.fn(async () => handle), upload: vi.fn(async () => undefined) };
}

describe("Workspace file capability boundary", () => {
  it("serves Volume reads using a file-only provider and never asks for compute", async () => {
    const files: SandboxWorkspaceFiles = {
      async readWorkspaceFile(request, signal) {
        expect(this).toBe(files);
        expect(request).toBe(read);
        expect(signal).toBe(controller.signal);
        return response;
      },
      async listWorkspaceDirectory(request) {
        return {
          ...identity,
          requestId: request.requestId,
          type: "workspace.directory_listed",
          entries: [],
          truncated: false,
        };
      },
    };
    const owner = admission(),
      controller = new AbortController();
    const access = new WorkspaceFileAccess(files, owner);
    expect(await access.readWorkspaceFile(read, controller.signal)).toBe(response);
    expect(await access.listWorkspaceDirectory(list)).toMatchObject({ entries: [] });
    expect(owner.machine).not.toHaveBeenCalled();
    expect(owner.upload).not.toHaveBeenCalled();
  });

  it("keeps an unavailable machine on its original route instead of falling back to Volume bytes", async () => {
    const unavailable = new SandboxControlError(
      "workspace_browser_unavailable",
      "Owner recovery pending",
      true,
    );
    const owner = admission();
    owner.machine = vi.fn(async () => {
      throw unavailable;
    });
    const files: SandboxWorkspaceFiles = {
      readWorkspaceFile: vi.fn(async () => response),
      readMachineWorkspaceFile: vi.fn(async () => response),
    };
    const access = new WorkspaceFileAccess(files, owner);
    await expect(access.readWorkspaceFile({ ...read, machine })).rejects.toBe(unavailable);
    await expect(access.listWorkspaceDirectory({ ...list, machine })).rejects.toBe(unavailable);
    expect(files.readWorkspaceFile).not.toHaveBeenCalled();
    expect(files.readMachineWorkspaceFile).not.toHaveBeenCalled();
  });

  it("uses the authorized machine handle without caching it across requests", async () => {
    const next = Object.freeze({ runtimeId: "replacement-machine" }) as SandboxHandle;
    const owner = admission();
    owner.machine = vi.fn().mockResolvedValueOnce(handle).mockResolvedValueOnce(next);
    const files: SandboxWorkspaceFiles = { readMachineWorkspaceFile: vi.fn(async () => response) };
    const access = new WorkspaceFileAccess(files, owner),
      request = { ...read, machine };
    await access.readWorkspaceFile(request);
    await access.readWorkspaceFile(request);
    expect(files.readMachineWorkspaceFile).toHaveBeenNthCalledWith(1, handle, request);
    expect(files.readMachineWorkspaceFile).toHaveBeenNthCalledWith(2, next, request);
  });

  it("refuses an upload before consuming its body when ownership admission fails", async () => {
    const denied = new Error("upload claim closed"),
      owner = admission();
    owner.upload = vi.fn(async () => {
      throw denied;
    });
    const consumed = vi.fn();
    const chunks = (async function* () {
      consumed();
      yield Buffer.from("source");
    })();
    const files: SandboxWorkspaceFiles = { uploadWorkspaceFile: vi.fn() };
    const access = new WorkspaceFileAccess(files, owner);
    await expect(access.uploadWorkspaceFile(upload, chunks)).rejects.toBe(denied);
    expect(consumed).not.toHaveBeenCalled();
    expect(files.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it("passes the original upload stream and cancellation through once, without buffering or retry", async () => {
    const controller = new AbortController(),
      cancelled = new Error("cancelled");
    const consumed = vi.fn();
    const chunks = (async function* () {
      consumed();
      yield Buffer.from("one");
      consumed();
      yield Buffer.from("two");
    })();
    const files: SandboxWorkspaceFiles = {
      uploadWorkspaceFile: vi.fn(async (request, body, signal) => {
        expect(request).toBe(upload);
        expect(body).toBe(chunks);
        expect(signal).toBe(controller.signal);
        const iterator = body[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual(Buffer.from("one"));
        controller.abort(cancelled);
        signal!.throwIfAborted();
        throw new Error("unreachable");
      }),
    };
    await expect(
      new WorkspaceFileAccess(files, admission()).uploadWorkspaceFile(
        upload,
        chunks,
        controller.signal,
      ),
    ).rejects.toBe(cancelled);
    expect(consumed).toHaveBeenCalledOnce();
    expect(files.uploadWorkspaceFile).toHaveBeenCalledOnce();
    await chunks.return(undefined);
  });

  it("does not redirect or replay a machine upload after an uncertain provider failure", async () => {
    const uncertain = new Error("reply lost"),
      owner = admission();
    owner.upload = vi.fn(async () => handle);
    const files: SandboxWorkspaceFiles = {
      uploadWorkspaceFile: vi.fn(),
      uploadMachineWorkspaceFile: vi.fn(async () => {
        throw uncertain;
      }),
    };
    const chunks = (async function* () {
      yield Buffer.from("source");
    })();
    await expect(
      new WorkspaceFileAccess(files, owner).uploadWorkspaceFile({ ...upload, machine }, chunks),
    ).rejects.toBe(uncertain);
    expect(files.uploadMachineWorkspaceFile).toHaveBeenCalledOnce();
    expect(files.uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it("reports an unsupported capability without synthesizing successful empty output", async () => {
    const access = new WorkspaceFileAccess({}, admission());
    await expect(access.readWorkspaceFile(read)).rejects.toMatchObject({
      code: "workspace_browser_unavailable",
      retryable: false,
    });
    await expect(access.listWorkspaceDirectory(list)).rejects.toMatchObject({
      code: "workspace_browser_unavailable",
      retryable: false,
    });
    await expect(access.readWorkspaceFile({ ...read, machine })).rejects.toMatchObject({
      code: "workspace_browser_unavailable",
      retryable: false,
    });
  });
});
