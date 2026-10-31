import type {
  SandboxControlListWorkspaceDirectoryRequest,
  SandboxControlListWorkspaceDirectoryResponse,
  SandboxControlReadWorkspaceFileRequest,
  SandboxControlReadWorkspaceFileResponse,
  WorkspaceUploadRequest,
} from "@pi-cloud/protocol";
import {
  SandboxControlError,
  type SandboxHandle,
  type SandboxWorkspaceFiles,
} from "./sandbox-provider.ts";

type MachineFileRequest =
  | SandboxControlListWorkspaceDirectoryRequest
  | SandboxControlReadWorkspaceFileRequest
  | WorkspaceUploadRequest;

/** Ownership stays with SandboxController. File access receives only its
 * authorized handle, never the owner's allocation or destruction capabilities. */
export type WorkspaceFileAdmission = {
  machine(request: MachineFileRequest): Promise<SandboxHandle>;
  upload(request: WorkspaceUploadRequest): Promise<SandboxHandle | undefined>;
};

export class WorkspaceFileAccess {
  constructor(
    private readonly files: SandboxWorkspaceFiles,
    private readonly admission: WorkspaceFileAdmission,
  ) {}

  async preparePackage(
    handle: SandboxHandle,
    input: Parameters<NonNullable<SandboxWorkspaceFiles["preparePackage"]>>[1],
    signal?: AbortSignal,
  ) {
    if (!this.files.preparePackage)
      throw new SandboxControlError(
        "package_preparation_unavailable",
        "Workspace package placement is unavailable",
        false,
      );
    return this.files.preparePackage(handle, input, signal);
  }

  async listWorkspaceDirectory(
    request: SandboxControlListWorkspaceDirectoryRequest,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse> {
    if (request.machine !== undefined) {
      const handle = await this.admission.machine(request);
      if (!this.files.listMachineWorkspaceDirectory)
        throw new SandboxControlError(
          "workspace_browser_unavailable",
          "Machine directory browsing is unavailable",
          false,
        );
      return this.files.listMachineWorkspaceDirectory(handle, request);
    }
    if (this.files.listWorkspaceDirectory === undefined)
      throw new SandboxControlError(
        "workspace_browser_unavailable",
        "The configured Sandbox Provider cannot list Workspace directories",
        false,
      );
    return this.files.listWorkspaceDirectory(request);
  }

  async readWorkspaceFile(
    request: SandboxControlReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlReadWorkspaceFileResponse> {
    if (request.machine !== undefined) {
      const handle = await this.admission.machine(request);
      if (!this.files.readMachineWorkspaceFile)
        throw new SandboxControlError(
          "workspace_browser_unavailable",
          "Machine file browsing is unavailable",
          false,
        );
      return this.files.readMachineWorkspaceFile(handle, request);
    }
    if (this.files.readWorkspaceFile === undefined)
      throw new SandboxControlError(
        "workspace_browser_unavailable",
        "The configured Sandbox Provider cannot read Workspace files",
        false,
      );
    return this.files.readWorkspaceFile(request, signal);
  }

  async uploadWorkspaceFile(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    const handle = await this.admission.upload(request);
    if (handle) {
      if (!this.files.uploadMachineWorkspaceFile)
        throw new SandboxControlError(
          "workspace_upload_unavailable",
          "Machine upload is unavailable",
          false,
        );
      return this.files.uploadMachineWorkspaceFile(handle, request, chunks, signal);
    }
    if (!this.files.uploadWorkspaceFile)
      throw new SandboxControlError(
        "workspace_upload_unavailable",
        "Workspace upload is unavailable",
        false,
      );
    return this.files.uploadWorkspaceFile(request, chunks, signal);
  }
}
