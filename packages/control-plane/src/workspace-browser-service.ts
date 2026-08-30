import type { Database } from "@pi-cloud/database";
import type {
  ToolBrokerListWorkspaceDirectoryRequest,
  ToolBrokerListWorkspaceDirectoryResponse,
  ToolBrokerReadWorkspaceFileRequest,
  ToolBrokerReadWorkspaceFileResponse,
  WorkspaceDirectoryResource,
} from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";

export interface TrustedWorkspaceBrowser {
  listWorkspaceDirectory(
    request: ToolBrokerListWorkspaceDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerListWorkspaceDirectoryResponse>;
  readWorkspaceFile(
    request: ToolBrokerReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerReadWorkspaceFileResponse>;
}

export type WorkspaceBrowserServiceOptions = Readonly<{
  database: Kysely<Database>;
  browser: TrustedWorkspaceBrowser;
  idGenerator?: () => string;
}>;

export class WorkspaceBrowserError extends Error {
  readonly code: "not_found" | "unavailable" | "invalid_path" | "file_too_large";

  constructor(code: WorkspaceBrowserError["code"], message: string) {
    super(message);
    this.name = "WorkspaceBrowserError";
    this.code = code;
  }
}

function relativeRoot(executionMode: "elastic" | "development_environment", directory: string) {
  const prefix = executionMode === "elastic" ? "/workspace" : "/home/user";
  if (directory === prefix) return "";
  if (!directory.startsWith(`${prefix}/`)) {
    throw new WorkspaceBrowserError("unavailable", "Session Workspace root is invalid");
  }
  return directory.slice(prefix.length + 1);
}

function browserPath(value: string, allowEmpty: boolean): string {
  if (allowEmpty && value.length === 0) return "";
  if (
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new WorkspaceBrowserError("invalid_path", "Workspace browser path is invalid");
  }
  return value;
}

export class WorkspaceBrowserService {
  readonly #database: Kysely<Database>;
  readonly #browser: TrustedWorkspaceBrowser;
  readonly #idGenerator: () => string;

  constructor(options: WorkspaceBrowserServiceOptions) {
    this.#database = options.database;
    this.#browser = options.browser;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async directory(
    tenantId: string,
    sessionId: string,
    pathValue: string,
  ): Promise<WorkspaceDirectoryResource> {
    const path = browserPath(pathValue, true);
    const session = await this.#session(tenantId, sessionId);
    let response: ToolBrokerListWorkspaceDirectoryResponse;
    try {
      response = await this.#browser.listWorkspaceDirectory({
        toolBrokerProtocolVersion: 1,
        type: "workspace.list_directory",
        requestId: this.#idGenerator(),
        tenantId,
        workspaceId: session.workspaceId,
        sessionId,
        rootPath: relativeRoot(session.executionMode, session.workingDirectory),
        path,
      });
    } catch {
      throw new WorkspaceBrowserError("unavailable", "Workspace directory is unavailable");
    }
    return {
      sessionId,
      workspaceId: session.workspaceId,
      path,
      entries: response.entries,
      truncated: response.truncated,
    };
  }

  async file(
    tenantId: string,
    sessionId: string,
    pathValue: string,
    maximumBytes: number,
  ): Promise<{ bytes: Uint8Array; sha256: string; executable: boolean }> {
    const path = browserPath(pathValue, false);
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 8 * 1_024 * 1_024
    ) {
      throw new WorkspaceBrowserError("file_too_large", "Workspace file size limit is invalid");
    }
    const session = await this.#session(tenantId, sessionId);
    let response: ToolBrokerReadWorkspaceFileResponse;
    try {
      response = await this.#browser.readWorkspaceFile({
        toolBrokerProtocolVersion: 1,
        type: "workspace.read_file",
        requestId: this.#idGenerator(),
        tenantId,
        workspaceId: session.workspaceId,
        sessionId,
        rootPath: relativeRoot(session.executionMode, session.workingDirectory),
        path,
        maximumBytes,
      });
    } catch {
      throw new WorkspaceBrowserError("unavailable", "Workspace file is unavailable");
    }
    return {
      bytes: Buffer.from(response.content, "base64"),
      sha256: response.sha256,
      executable: response.executable,
    };
  }

  async #session(tenantId: string, sessionId: string) {
    const row = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .select([
        "session_row.workspace_id as workspaceId",
        "session_row.execution_mode as executionMode",
        "session_row.working_directory as workingDirectory",
      ])
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", sessionId)
      .where("workspace.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined)
      throw new WorkspaceBrowserError("not_found", "Session Workspace was not found");
    return row;
  }
}
