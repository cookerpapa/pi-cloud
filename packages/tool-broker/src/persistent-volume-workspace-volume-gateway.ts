import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isIPv4 } from "node:net";
import {
  VOLUME_IDENTITY_FILE,
  VOLUME_METADATA_DIRECTORY,
  VOLUME_DELETE_FILE,
  volumeDeleteMarker,
  VOLUME_WORKSPACE_DIRECTORY,
  WORKSPACE_GIT_CREDENTIALS_FILE,
  WorkspaceVolumeGatewayError,
  safeRelativeFile,
  validatedAbsoluteDirectory,
  validatedIdentity,
  validatedVolumeIdentity,
  type PersistentVolumeWorkspaceVolumeGatewayOptions,
  type VolumeIdentity,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayLock,
  type WorkspaceVolumeGatewayDeleteInput,
  type WorkspaceVolumeGatewayPathInput,
  type WorkspaceVolumeGatewayVerifyInput,
  type WorkspaceVolumeGatewayReadFileInput,
  type WorkspaceVolumeGatewaySourceCredentialAuthorizeInput,
  type WorkspaceVolumeGatewaySourceCredentialDisconnectInput,
  type WorkspaceVolumeGatewaySourceCredentialListInput,
  type WorkspaceVolumeGatewaySourceCredentialPreflightInput,
  type WorkspaceVolumeGitRunner,
} from "./workspace-volume-gateway-contract.ts";

const GIT_TIMEOUT_MS = 5 * 60_000;

async function readAtMost(file: Awaited<ReturnType<typeof open>>, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await file.read(buffer, length, limit - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

function safeBrowsePath(value: string, allowEmpty: boolean): string {
  if (allowEmpty && value.length === 0) return "";
  const path = safeRelativeFile(value);
  if (
    path
      .split("/")
      .some((segment) => segment === ".git" || segment === WORKSPACE_GIT_CREDENTIALS_FILE)
  ) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_path_hidden",
      "Workspace path is not available in the file browser",
      false,
    );
  }
  return path;
}

function rethrowBrowseFailure(error: unknown): never {
  if (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
  ) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_path_unavailable",
      "Workspace path does not exist or is not accessible",
      false,
    );
  }
  throw error;
}

function privateGitHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  if (!isIPv4(hostname)) return false;
  const [first, second] = hostname.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function trustedGitEnvironment(
  credential?: Readonly<{
    provider: "github" | "gitlab";
    cloneUrl: string;
    accessToken: string;
  }>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (credential !== undefined) {
    const cloneUrl = new URL(credential.cloneUrl);
    const origin = cloneUrl.origin;
    if (privateGitHost(cloneUrl.hostname)) {
      const noProxy = new Set(
        (environment.NO_PROXY ?? environment.no_proxy ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      noProxy.add(cloneUrl.hostname);
      environment.NO_PROXY = [...noProxy].join(",");
      environment.no_proxy = environment.NO_PROXY;
    }
    const username = credential.provider === "github" ? "x-access-token" : "oauth2";
    environment.GIT_CONFIG_COUNT = "2";
    environment.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `${username}:${credential.accessToken}`,
      "utf8",
    ).toString("base64")}`;
    environment.GIT_CONFIG_KEY_1 = "credential.helper";
    environment.GIT_CONFIG_VALUE_1 = "";
  }
  return environment;
}

function credentialOriginUrl(
  provider: "github" | "gitlab",
  origin: string,
  accessToken: string,
): string {
  const url = new URL(origin);
  url.username = provider === "github" ? "x-access-token" : "oauth2";
  url.password = accessToken;
  return url.toString();
}

function credentialOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function storedCredentialUrl(value: string): URL {
  const schemeEnd = value.indexOf("://");
  const authorityEnd = schemeEnd < 0 ? -1 : value.indexOf("/", schemeEnd + 3);
  if (authorityEnd < 0) return new URL(value);
  const authority = value.slice(schemeEnd + 3, authorityEnd);
  const userInfoEnd = authority.lastIndexOf("@");
  if (userInfoEnd < 0) return new URL(value);
  const normalizedAuthority = `${authority.slice(0, userInfoEnd + 1)}${authority
    .slice(userInfoEnd + 1)
    .replace(/%3a/giu, ":")}`;
  return new URL(
    `${value.slice(0, schemeEnd + 3)}${normalizedAuthority}${value.slice(authorityEnd)}`,
  );
}

async function storedCredentials(path: string): Promise<URL[]> {
  let value: string;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 256 * 1024) {
      throw new WorkspaceVolumeGatewayError(
        "source_control_credential_home_invalid",
        "Workspace Git credential store was invalid",
        false,
      );
    }
    value = (await readAtMost(file, 256 * 1024 + 1)).toString("utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  } finally {
    await file?.close();
  }
  if (Buffer.byteLength(value, "utf8") > 256 * 1_024) {
    throw new WorkspaceVolumeGatewayError(
      "source_control_credential_home_invalid",
      "Workspace Git credential store was invalid",
      false,
    );
  }
  const credentials = value.split(/\r?\n/u).filter(Boolean).map(storedCredentialUrl);
  if (credentials.length > 64) {
    throw new WorkspaceVolumeGatewayError(
      "source_control_credential_home_invalid",
      "Workspace Git credential store was invalid",
      false,
    );
  }
  return credentials;
}

function credentialProvider(url: URL): "github" | "gitlab" | undefined {
  if (url.username === "x-access-token") return "github";
  if (url.username === "oauth2") return "gitlab";
  return undefined;
}

export function runTrustedWorkspaceGit(
  args: readonly string[],
  options: {
    credential?: Readonly<{
      provider: "github" | "gitlab";
      cloneUrl: string;
      accessToken: string;
    }>;
    allowedExitCodes?: readonly number[];
    retryable?: boolean;
  },
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "/usr/bin/git",
      [...args],
      {
        // A network credential probe must never discover a user-controlled
        // .git/config (URL rewrites and custom SSH commands can execute code).
        cwd: "/",
        env: trustedGitEnvironment(options.credential),
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
        timeout: GIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        const exitCode =
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
            ? error.code
            : error === null
              ? 0
              : -1;
        if (exitCode === 0 || options.allowedExitCodes?.includes(exitCode)) {
          resolvePromise({ stdout, exitCode });
          return;
        }
        rejectPromise(
          new WorkspaceVolumeGatewayError(
            "source_control_git_failed",
            "Trusted source-control Git operation failed",
            options.retryable ?? exitCode < 0,
          ),
        );
      },
    );
  });
}

/** Trusted direct access to Cube's durable POSIX Workspace volumes. */
export class PersistentVolumeWorkspaceVolumeGateway implements WorkspaceVolumeGateway {
  readonly #workspaceRoot: string;
  readonly #distributedLock: WorkspaceVolumeGatewayLock | undefined;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #git: WorkspaceVolumeGitRunner;

  constructor(options: PersistentVolumeWorkspaceVolumeGatewayOptions) {
    this.#workspaceRoot = validatedAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    this.#distributedLock = options.lock;
    this.#git = options.gitRunner ?? runTrustedWorkspaceGit;
  }

  async checkHealth(): Promise<void> {
    const metadata = await lstat(this.#workspaceRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_root_invalid",
        "Persistent Workspace Volume root was invalid",
        false,
      );
    }
  }

  async verify(input: WorkspaceVolumeGatewayVerifyInput): Promise<{ verified: true }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.#validatedVolume(identity);
      return { verified: true };
    });
  }

  async listDirectory(input: WorkspaceVolumeGatewayPathInput): Promise<{
    entries: readonly import("./workspace-volume-gateway-contract.ts").WorkspaceVolumeDirectoryEntry[];
    truncated: boolean;
  }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      if (input.rootPath === "" && input.path === "") {
        const present = await lstat(this.#volumeDirectory(identity.volumeId)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (present === undefined) return { entries: [], truncated: false };
      }
      const directory = await this.#validatedVolume(identity);
      const target = await this.#browseTarget(directory, input.rootPath, input.path, true);
      const handle = await this.#openBrowseTarget(target, true);
      try {
        const openedDirectory = `/proc/self/fd/${handle.fd}`;
        const listed = (await readdir(openedDirectory, { withFileTypes: true }))
          .filter((entry) => entry.name !== ".git" && entry.name !== WORKSPACE_GIT_CREDENTIALS_FILE)
          .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
          .sort((left, right) => left.name.localeCompare(right.name));
        const entries = await Promise.all(
          listed.slice(0, 4_096).map(async (entry) => {
            const path =
              target.relative.length === 0 ? entry.name : `${target.relative}/${entry.name}`;
            if (entry.isSymbolicLink()) return { name: entry.name, path, kind: "symlink" as const };
            if (entry.isDirectory()) return { name: entry.name, path, kind: "directory" as const };
            const file = await lstat(join(openedDirectory, entry.name)).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              },
            );
            if (!file) return undefined;
            return {
              name: entry.name,
              path,
              kind: "file" as const,
              sizeBytes: file.size,
              executable: (file.mode & 0o111) !== 0,
            };
          }),
        );
        return {
          entries: entries.filter(
            (entry): entry is NonNullable<typeof entry> => entry !== undefined,
          ),
          truncated: listed.length > 4_096,
        };
      } finally {
        await handle.close();
      }
    }).catch(rethrowBrowseFailure);
  }

  async readFile(input: WorkspaceVolumeGatewayReadFileInput): Promise<{
    bytes: Uint8Array;
    sha256: string;
    executable: boolean;
  }> {
    const identity = validatedIdentity(input);
    if (
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 8 * 1_024 * 1_024
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_read_request_invalid",
        "Workspace file read request was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const target = await this.#browseTarget(directory, input.rootPath, input.path, false);
      const handle = await this.#openBrowseTarget(target, false);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > input.maximumBytes) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_file_invalid",
            "Workspace file was unavailable or too large",
            false,
          );
        }
        const bytes = await readAtMost(handle, input.maximumBytes + 1);
        if (bytes.length > input.maximumBytes) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_file_invalid",
            "Workspace file grew beyond its read limit",
            false,
          );
        }
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: (metadata.mode & 0o111) !== 0,
        };
      } finally {
        await handle.close();
      }
    }).catch(rethrowBrowseFailure);
  }

  async authorizeSourceCredential(
    input: WorkspaceVolumeGatewaySourceCredentialAuthorizeInput,
  ): Promise<{ authorized: true }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const workspace = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      const credentialPath = join(workspace, WORKSPACE_GIT_CREDENTIALS_FILE);
      const credentialUrl = credentialOriginUrl(input.provider, input.origin, input.accessToken);
      const retained = (await storedCredentials(credentialPath)).filter(
        (candidate) => credentialOrigin(candidate.toString()) !== input.origin,
      );
      retained.push(storedCredentialUrl(credentialUrl));
      retained.sort((left, right) => left.origin.localeCompare(right.origin));
      const suffix = randomBytes(12).toString("hex");
      const temporary = join(workspace, `${WORKSPACE_GIT_CREDENTIALS_FILE}-${suffix}.tmp`);
      await writeFile(temporary, `${retained.map((entry) => entry.toString()).join("\n")}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, credentialPath);
      return { authorized: true };
    });
  }

  async preflightSourceCredential(
    input: WorkspaceVolumeGatewaySourceCredentialPreflightInput,
  ): Promise<{
    authorized: boolean;
    reason?: "credential_missing" | "credential_rejected" | "code_host_unreachable";
  }> {
    const identity = validatedIdentity(input);
    const credentialUrl = await this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const credentialPath = join(
        directory,
        VOLUME_WORKSPACE_DIRECTORY,
        WORKSPACE_GIT_CREDENTIALS_FILE,
      );
      return (await storedCredentials(credentialPath)).find(
        (candidate) =>
          credentialOrigin(candidate.toString()) === input.origin &&
          credentialProvider(candidate) === input.provider,
      );
    });
    if (credentialUrl === undefined || credentialUrl.password.length < 16) {
      return { authorized: false, reason: "credential_missing" };
    }
    // The probe uses only this credential value, not Workspace bytes. Do not
    // hold a Volume lock or a PG lock connection through a remote network wait.
    try {
      await this.#git(["ls-remote", input.verificationCloneUrl], {
        credential: {
          provider: input.provider,
          cloneUrl: input.verificationCloneUrl,
          accessToken: decodeURIComponent(credentialUrl.password),
        },
        retryable: true,
      });
      return { authorized: true };
    } catch (error: unknown) {
      return {
        authorized: false,
        reason:
          error instanceof WorkspaceVolumeGatewayError && error.retryable
            ? "code_host_unreachable"
            : "credential_rejected",
      };
    }
  }

  async listSourceCredentials(
    input: WorkspaceVolumeGatewaySourceCredentialListInput,
  ): Promise<{ connections: readonly { provider: "github" | "gitlab"; origin: string }[] }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const credentialPath = join(
        directory,
        VOLUME_WORKSPACE_DIRECTORY,
        WORKSPACE_GIT_CREDENTIALS_FILE,
      );
      const connections = (await storedCredentials(credentialPath))
        .map((credential) => {
          const provider = credentialProvider(credential);
          return provider === undefined ? undefined : { provider, origin: credential.origin };
        })
        .filter(
          (connection): connection is { provider: "github" | "gitlab"; origin: string } =>
            connection !== undefined,
        )
        .sort((left, right) => left.origin.localeCompare(right.origin));
      return { connections };
    });
  }

  async disconnectSourceCredential(
    input: WorkspaceVolumeGatewaySourceCredentialDisconnectInput,
  ): Promise<{ disconnected: boolean }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const workspace = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      const credentialPath = join(workspace, WORKSPACE_GIT_CREDENTIALS_FILE);
      const existing = await storedCredentials(credentialPath);
      const retained = existing.filter(
        (candidate) =>
          credentialOrigin(candidate.toString()) !== input.origin ||
          credentialProvider(candidate) !== input.provider,
      );
      if (retained.length === existing.length) return { disconnected: false };
      if (retained.length === 0) {
        await rm(credentialPath, { force: true });
      } else {
        const temporary = join(
          workspace,
          `${WORKSPACE_GIT_CREDENTIALS_FILE}-${randomBytes(12).toString("hex")}.tmp`,
        );
        await writeFile(temporary, `${retained.map((entry) => entry.toString()).join("\n")}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, credentialPath);
      }
      return { disconnected: true };
    });
  }

  async #deletionEnvelope(
    identity: ReturnType<typeof validatedVolumeIdentity>,
  ): Promise<{ directory: string; marker: string } | undefined> {
    const directory = this.#volumeDirectory(identity.volumeId);
    const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata === undefined) return undefined;
    const stored = await this.#readVolumeIdentity(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      stored.volumeId !== identity.volumeId
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_binding_invalid",
        "Persistent Workspace Volume identity was invalid",
        false,
      );
    }
    return { directory, marker: volumeDeleteMarker(identity.volumeId, stored.generation) };
  }

  async prepareDelete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ prepared: boolean }> {
    const identity = validatedVolumeIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const envelope = await this.#deletionEnvelope(identity);
      if (envelope === undefined) return { prepared: false };
      const target = join(envelope.directory, VOLUME_METADATA_DIRECTORY, VOLUME_DELETE_FILE);
      const temporary = `${target}.${randomBytes(8).toString("hex")}`;
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o400,
        );
        try {
          await file.writeFile(envelope.marker);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        const directory = await open(dirname(target), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return { prepared: true };
    });
  }

  async finalizeDelete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ deleted: boolean }> {
    const identity = validatedVolumeIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const retired = `${this.#volumeDirectory(identity.volumeId)}.deleted`;
      const envelope = await this.#deletionEnvelope(identity);
      if (envelope === undefined) {
        await rm(retired, { recursive: true, force: true });
        return { deleted: false };
      }
      const target = join(envelope.directory, VOLUME_METADATA_DIRECTORY, VOLUME_DELETE_FILE);
      const marker = await readFile(target, "utf8");
      if (marker !== envelope.marker)
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_delete_invalid",
          "Volume deletion was not authorized",
          false,
        );
      const workspace = await lstat(join(envelope.directory, VOLUME_WORKSPACE_DIRECTORY)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (workspace !== undefined)
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_delete_pending",
          "Cube has not removed Workspace bytes",
          true,
        );
      // Retire the complete trusted envelope atomically. A process crash while
      // removing these metadata files cannot invalidate the next GC retry.
      await rename(envelope.directory, retired);
      const parent = await open(this.#workspaceRoot, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      await rm(retired, { recursive: true, force: true });
      return { deleted: true };
    });
  }

  async #assertNotDeleting(directory: string): Promise<void> {
    const marker = await lstat(
      join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_DELETE_FILE),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (marker !== undefined)
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_deleting",
        "Workspace Volume is being deleted",
        false,
      );
  }

  async close(): Promise<void> {}

  async #validatedVolume(identity: ReturnType<typeof validatedIdentity>): Promise<string> {
    // Only the Cube plugin creates a Volume. Reads never recreate a deleted path.
    const directory = this.#volumeDirectory(identity.volumeId);
    await this.#assertNotDeleting(directory);
    const stored = await this.#readVolumeIdentity(directory);
    if (
      stored.volumeId !== identity.volumeId ||
      !(await this.#hasValidWorkspaceDirectory(directory))
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_binding_invalid",
        "Persistent Workspace Volume identity was invalid",
        false,
      );
    }
    return directory;
  }

  #volumeDirectory(volumeId: string): string {
    const directory = resolve(this.#workspaceRoot, `picloud-posix-${volumeId}`);
    if (!directory.startsWith(`${this.#workspaceRoot}${sep}`)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_path_invalid",
        "Workspace Volume path was invalid",
        false,
      );
    }
    return directory;
  }

  async #hasValidWorkspaceDirectory(directory: string): Promise<boolean> {
    try {
      const metadata = await lstat(join(directory, VOLUME_WORKSPACE_DIRECTORY));
      return metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async #readVolumeIdentity(directory: string): Promise<VolumeIdentity> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      for (const path of [directory, join(directory, VOLUME_METADATA_DIRECTORY)]) {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new WorkspaceVolumeGatewayError(
            "workspace_volume_path_invalid",
            "Workspace Volume path was invalid",
            false,
          );
      }
      file = await open(
        join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_IDENTITY_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const metadata = await file.stat();
      const contents = metadata.isFile() ? (await readAtMost(file, 257)).toString("utf8") : "";
      const match = /^pi-cloud-volume-v1\n(pcw-[0-9a-f]{48})\n([0-9a-f]{64})\n?$/.exec(contents);
      if (!match)
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_binding_invalid",
          "Plugin-created Workspace Volume identity was invalid",
          false,
        );
      return { volumeId: match[1]!, generation: match[2]! };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_identity_unavailable",
          "Workspace Volume has no identity published by its Cube plugin",
          false,
        );
      throw error;
    } finally {
      await file?.close();
    }
  }

  async #withVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const run = () => this.#withLocalVolumeLock(volumeId, operation);
    return this.#distributedLock === undefined
      ? run()
      : this.#distributedLock.withLock(volumeId, run);
  }

  async #openBrowseTarget(
    target: { absolute: string; root: string },
    directory: boolean,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    const handle = await open(
      target.absolute,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (directory ? constants.O_DIRECTORY : 0),
    );
    try {
      // On the supported Linux host, inspect the opened object, not just the
      // pathname checked before open. Guest directory renames must not redirect
      // trusted reads into a different Volume. Directory reads keep this fd too.
      const actual = await realpath(`/proc/self/fd/${handle.fd}`);
      if (actual !== target.root && !actual.startsWith(`${target.root}${sep}`)) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_path_escape",
          "Workspace browser path escaped its selected root",
          false,
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #browseTarget(
    directory: string,
    rootPathValue: string,
    pathValue: string,
    pathMayBeEmpty: boolean,
  ): Promise<{ absolute: string; relative: string; root: string }> {
    const rootPath = safeBrowsePath(rootPathValue, true);
    const path = safeBrowsePath(pathValue, pathMayBeEmpty);
    const volumeRoot = await realpath(join(directory, VOLUME_WORKSPACE_DIRECTORY));
    const selectedRoot = await realpath(
      rootPath.length === 0 ? volumeRoot : resolve(volumeRoot, rootPath),
    );
    if (selectedRoot !== volumeRoot && !selectedRoot.startsWith(`${volumeRoot}${sep}`)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_path_escape",
        "Workspace browser root escaped its Volume",
        false,
      );
    }
    const absolute = await realpath(path.length === 0 ? selectedRoot : resolve(selectedRoot, path));
    if (absolute !== selectedRoot && !absolute.startsWith(`${selectedRoot}${sep}`)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_path_escape",
        "Workspace browser path escaped its selected root",
        false,
      );
    }
    return { absolute, relative: path, root: selectedRoot };
  }

  async #withLocalVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(volumeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.#locks.set(volumeId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(volumeId) === tail) this.#locks.delete(volumeId);
    }
  }
}
