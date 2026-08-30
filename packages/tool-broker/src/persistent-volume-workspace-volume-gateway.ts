import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
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
  SHA256_PATTERN,
  UUID_PATTERN,
  VOLUME_GENERATION_FILE,
  VOLUME_GENERATION_PATTERN,
  VOLUME_METADATA_DIRECTORY,
  VOLUME_SETTLEMENT_FILE,
  VOLUME_WORKSPACE_DIRECTORY,
  WORKSPACE_GIT_HOME_DIRECTORY,
  WorkspaceVolumeGatewayError,
  isRecord,
  safeRelativeFile,
  validatedAbsoluteDirectory,
  validatedIdentity,
  validatedVolumeIdentity,
  type PersistentVolumeWorkspaceVolumeGatewayOptions,
  type VolumeState,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayLock,
  type WorkspaceVolumeGatewayDeleteInput,
  type WorkspaceVolumeGatewayForkInput,
  type WorkspaceVolumeGatewayPathInput,
  type WorkspaceVolumeGatewayPrepareInput,
  type WorkspaceVolumeGatewayReadFileInput,
  type WorkspaceVolumeGatewaySettleInput,
  type WorkspaceVolumeGatewaySourceCredentialAuthorizeInput,
  type WorkspaceVolumeGatewaySourceCredentialPreflightInput,
  type WorkspaceVolumeGitRunner,
} from "./workspace-volume-gateway-contract.ts";

const GIT_TIMEOUT_MS = 5 * 60_000;

function safeBrowsePath(value: string, allowEmpty: boolean): string {
  if (allowEmpty && value.length === 0) return "";
  const path = safeRelativeFile(value);
  if (
    path
      .split("/")
      .some((segment) => segment === ".git" || segment === WORKSPACE_GIT_HOME_DIRECTORY)
  ) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_path_hidden",
      "Workspace path is not available in the file browser",
      false,
    );
  }
  return path;
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

function credentialCloneUrl(
  provider: "github" | "gitlab",
  cloneUrl: string,
  accessToken: string,
): string {
  const url = new URL(cloneUrl);
  url.username = provider === "github" ? "x-access-token" : "oauth2";
  url.password = accessToken;
  return url.toString();
}

function credentialFreeCloneUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
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

export function runTrustedWorkspaceGit(
  args: readonly string[],
  options: {
    cwd: string;
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
        cwd: options.cwd,
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
    await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#workspaceRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_root_invalid",
        "Persistent Workspace Volume root was invalid",
        false,
      );
    }
  }

  async prepare(input: WorkspaceVolumeGatewayPrepareInput): Promise<{ attached: boolean }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.checkHealth();
      const directory = await this.#ensureVolumeDirectory(identity.volumeId);
      const state = await this.#readState(directory);
      const generation = await this.#readVolumeGeneration(directory);
      const workspaceValid = await this.#hasValidWorkspaceDirectory(directory);
      const entries = await readdir(directory);
      const pristinePluginWorkspace =
        state === undefined &&
        generation === undefined &&
        workspaceValid &&
        entries.length === 1 &&
        entries[0] === VOLUME_WORKSPACE_DIRECTORY &&
        (await readdir(join(directory, VOLUME_WORKSPACE_DIRECTORY))).length === 0;
      if (
        !pristinePluginWorkspace &&
        (state !== undefined || generation !== undefined || workspaceValid)
      ) {
        if (
          state === undefined ||
          generation === undefined ||
          !workspaceValid ||
          state.tenantId !== identity.tenantId ||
          state.workspaceId !== identity.workspaceId ||
          state.volumeId !== identity.volumeId ||
          state.volumeGeneration !== generation
        ) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_volume_binding_invalid",
            "Persistent Workspace Volume identity was invalid",
            false,
          );
        }
        return { attached: true };
      }
      if (!pristinePluginWorkspace && entries.length !== 0) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_contents_invalid",
          "Uninitialized Workspace Volume was not empty",
          false,
        );
      }
      const workspaceDirectory = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      if (!workspaceValid) await mkdir(workspaceDirectory, { mode: 0o700 });
      const metadataDirectory = join(directory, VOLUME_METADATA_DIRECTORY);
      await mkdir(metadataDirectory, { mode: 0o700 });
      const volumeGeneration = randomBytes(32).toString("hex");
      await writeFile(join(metadataDirectory, VOLUME_GENERATION_FILE), `${volumeGeneration}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      await this.#writeState(directory, {
        schemaVersion: 2,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        volumeId: identity.volumeId,
        volumeGeneration,
      });
      return { attached: false };
    });
  }

  async settle(input: WorkspaceVolumeGatewaySettleInput): Promise<{ settlementRevision: string }> {
    const identity = validatedIdentity(input);
    if (
      !UUID_PATTERN.test(input.activationId) ||
      !Number.isSafeInteger(input.fencingToken) ||
      input.fencingToken < 1 ||
      !SHA256_PATTERN.test(input.bindingSha256)
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_settlement_fence_invalid",
        "Workspace settlement fence was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const settlementRevision = randomBytes(32).toString("hex");
      await this.#writeSettlementRevision(directory, settlementRevision);
      return { settlementRevision };
    });
  }

  async fork(input: WorkspaceVolumeGatewayForkInput): Promise<{
    sourceSettlementRevision: string;
    targetSettlementRevision: string;
  }> {
    if (!SHA256_PATTERN.test(input.expectedSourceSettlementRevision)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_fork_settlement_invalid",
        "Workspace fork source settlement was invalid",
        false,
      );
    }
    const source = validatedIdentity({
      tenantId: input.tenantId,
      workspaceId: input.sourceWorkspaceId,
      sessionId: input.sourceSessionId,
      volumeId: input.sourceVolumeId,
    });
    const target = validatedIdentity({
      tenantId: input.tenantId,
      workspaceId: input.targetWorkspaceId,
      sessionId: input.targetSessionId,
      volumeId: input.targetVolumeId,
    });
    if (source.workspaceId === target.workspaceId || source.volumeId === target.volumeId) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_fork_identity_invalid",
        "Workspace fork target must be independent",
        false,
      );
    }
    return this.#withVolumeLocks([source.volumeId, target.volumeId], async () => {
      await this.checkHealth();
      const sourceDirectory = await this.#validatedVolume(source);
      const targetDirectory = await this.#ensureVolumeDirectory(target.volumeId);
      const existingState = await this.#readState(targetDirectory);
      const existingGeneration = await this.#readVolumeGeneration(targetDirectory);
      if (existingState !== undefined || existingGeneration !== undefined) {
        if (
          existingState === undefined ||
          existingGeneration === undefined ||
          existingState.tenantId !== target.tenantId ||
          existingState.workspaceId !== target.workspaceId ||
          existingState.volumeId !== target.volumeId ||
          existingState.volumeGeneration !== existingGeneration ||
          existingState.forkedFrom?.workspaceId !== source.workspaceId ||
          existingState.forkedFrom.settlementRevision !== input.expectedSourceSettlementRevision
        ) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_target_conflict",
            "Workspace fork target was already bound to another source",
            false,
          );
        }
        const targetSettlementRevision = await this.#readSettlementRevision(targetDirectory);
        if (targetSettlementRevision === undefined) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_target_conflict",
            "Workspace fork target settlement was missing",
            false,
          );
        }
        return {
          sourceSettlementRevision: existingState.forkedFrom.settlementRevision,
          targetSettlementRevision,
        };
      }
      const sourceSettlementRevision = await this.#readSettlementRevision(sourceDirectory);
      if (sourceSettlementRevision !== input.expectedSourceSettlementRevision) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_fork_source_settlement_changed",
          "Workspace settlement changed before the isolated fork was copied",
          true,
        );
      }
      const targetEntries = await readdir(targetDirectory);
      const pristine =
        targetEntries.length === 0 ||
        (targetEntries.length === 1 &&
          targetEntries[0] === VOLUME_WORKSPACE_DIRECTORY &&
          (await readdir(join(targetDirectory, VOLUME_WORKSPACE_DIRECTORY))).length === 0);
      if (!pristine) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_fork_target_conflict",
          "Workspace fork target was not pristine",
          false,
        );
      }

      const temporary = `${targetDirectory}.fork-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        await cp(sourceDirectory, temporary, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
        const volumeGeneration = randomBytes(32).toString("hex");
        const generationPath = join(temporary, VOLUME_METADATA_DIRECTORY, VOLUME_GENERATION_FILE);
        await rm(generationPath, { force: true });
        await writeFile(generationPath, `${volumeGeneration}\n`, { mode: 0o400, flag: "wx" });
        const targetSettlementRevision = randomBytes(32).toString("hex");
        await this.#writeState(temporary, {
          schemaVersion: 2,
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          volumeId: target.volumeId,
          volumeGeneration,
          forkedFrom: {
            workspaceId: source.workspaceId,
            settlementRevision: sourceSettlementRevision,
          },
        });
        await this.#writeSettlementRevision(temporary, targetSettlementRevision);
        await rm(targetDirectory, { recursive: true, force: true });
        await rename(temporary, targetDirectory);
        return {
          sourceSettlementRevision,
          targetSettlementRevision,
        };
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async listDirectory(input: WorkspaceVolumeGatewayPathInput): Promise<{
    entries: readonly import("./workspace-volume-gateway-contract.ts").WorkspaceVolumeDirectoryEntry[];
    truncated: boolean;
  }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const target = await this.#browseTarget(directory, input.rootPath, input.path, true);
      const metadata = await lstat(target.absolute);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_directory_invalid",
          "Workspace directory was unavailable",
          false,
        );
      }
      const listed = (await readdir(target.absolute, { withFileTypes: true }))
        .filter((entry) => entry.name !== ".git" && entry.name !== WORKSPACE_GIT_HOME_DIRECTORY)
        .sort((left, right) => left.name.localeCompare(right.name));
      const entries = await Promise.all(
        listed.slice(0, 4_096).map(async (entry) => {
          const path =
            target.relative.length === 0 ? entry.name : `${target.relative}/${entry.name}`;
          if (entry.isSymbolicLink()) return { name: entry.name, path, kind: "symlink" as const };
          if (entry.isDirectory()) return { name: entry.name, path, kind: "directory" as const };
          const file = await lstat(join(target.absolute, entry.name));
          return {
            name: entry.name,
            path,
            kind: "file" as const,
            sizeBytes: file.size,
            executable: (file.mode & 0o111) !== 0,
          };
        }),
      );
      return { entries, truncated: listed.length > entries.length };
    });
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
      const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > input.maximumBytes) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_file_invalid",
            "Workspace file was unavailable or too large",
            false,
          );
        }
        const bytes = await handle.readFile();
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: (metadata.mode & 0o111) !== 0,
        };
      } finally {
        await handle.close();
      }
    });
  }

  async authorizeSourceCredential(
    input: WorkspaceVolumeGatewaySourceCredentialAuthorizeInput,
  ): Promise<{ authorized: true }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const workspace = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      const credentialHome = join(workspace, WORKSPACE_GIT_HOME_DIRECTORY);
      await mkdir(credentialHome, { mode: 0o700 });
      const homeMetadata = await lstat(credentialHome);
      if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
        throw new WorkspaceVolumeGatewayError(
          "source_control_credential_home_invalid",
          "Workspace Git credential home was invalid",
          false,
        );
      }
      const guestHome = `${input.credentialMountPath}/${WORKSPACE_GIT_HOME_DIRECTORY}`;
      const credentialUrl = credentialCloneUrl(
        input.provider,
        input.userCloneUrl,
        input.accessToken,
      );
      const suffix = randomBytes(12).toString("hex");
      const configTemporary = join(credentialHome, `.gitconfig-${suffix}.tmp`);
      const credentialTemporary = join(credentialHome, `.git-credentials-${suffix}.tmp`);
      await writeFile(
        configTemporary,
        `[credential]\n\thelper = store --file=${guestHome}/.git-credentials\n\tuseHttpPath = true\n`,
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(credentialTemporary, `${credentialUrl}\n`, { mode: 0o600, flag: "wx" });
      await Promise.all([chmod(configTemporary, 0o600), chmod(credentialTemporary, 0o600)]);
      await rename(configTemporary, join(credentialHome, ".gitconfig"));
      await rename(credentialTemporary, join(credentialHome, ".git-credentials"));
      return { authorized: true };
    });
  }

  async preflightSourceCredential(
    input: WorkspaceVolumeGatewaySourceCredentialPreflightInput,
  ): Promise<{
    authorized: boolean;
    reason?: "credential_missing" | "credential_rejected" | "gitlab_unreachable";
  }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const credentialPath = join(
        directory,
        VOLUME_WORKSPACE_DIRECTORY,
        WORKSPACE_GIT_HOME_DIRECTORY,
        ".git-credentials",
      );
      let credentialUrl: URL;
      try {
        credentialUrl = storedCredentialUrl((await readFile(credentialPath, "utf8")).trim());
      } catch {
        return { authorized: false, reason: "credential_missing" };
      }
      if (
        credentialUrl.password.length < 16 ||
        credentialFreeCloneUrl(credentialUrl.toString()) !==
          credentialFreeCloneUrl(input.userCloneUrl)
      ) {
        return { authorized: false, reason: "credential_missing" };
      }
      try {
        await this.#git(["ls-remote", input.verificationCloneUrl], {
          cwd: join(directory, VOLUME_WORKSPACE_DIRECTORY),
          credential: {
            provider: input.provider,
            cloneUrl: input.verificationCloneUrl,
            accessToken: decodeURIComponent(credentialUrl.password),
          },
          retryable: true,
        });
        return { authorized: true };
      } catch {
        return { authorized: false, reason: "credential_rejected" };
      }
    });
  }

  async delete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ deleted: boolean }> {
    const identity = validatedVolumeIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = this.#volumeDirectory(identity.volumeId);
      let metadata;
      try {
        metadata = await lstat(directory);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { deleted: false };
        }
        throw error;
      }
      const state = await this.#readState(directory);
      const generation = await this.#readVolumeGeneration(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        state === undefined ||
        generation === undefined ||
        state.tenantId !== identity.tenantId ||
        state.workspaceId !== identity.workspaceId ||
        state.volumeId !== identity.volumeId ||
        state.volumeGeneration !== generation ||
        !(await this.#hasValidWorkspaceDirectory(directory))
      ) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_binding_invalid",
          "Persistent Workspace Volume identity was invalid",
          false,
        );
      }
      await rm(directory, { recursive: true, force: false });
      return { deleted: true };
    });
  }

  async close(): Promise<void> {}

  async #validatedVolume(identity: ReturnType<typeof validatedIdentity>): Promise<string> {
    const directory = await this.#ensureVolumeDirectory(identity.volumeId);
    const state = await this.#readState(directory);
    const generation = await this.#readVolumeGeneration(directory);
    if (
      state === undefined ||
      generation === undefined ||
      state.tenantId !== identity.tenantId ||
      state.workspaceId !== identity.workspaceId ||
      state.volumeId !== identity.volumeId ||
      state.volumeGeneration !== generation ||
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

  async #ensureVolumeDirectory(volumeId: string): Promise<string> {
    const directory = this.#volumeDirectory(volumeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_path_invalid",
        "Workspace Volume path was invalid",
        false,
      );
    }
    await chmod(directory, 0o700);
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

  async #readVolumeGeneration(directory: string): Promise<string | undefined> {
    try {
      const value = (
        await readFile(join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GENERATION_FILE), "utf8")
      ).trim();
      return VOLUME_GENERATION_PATTERN.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  #statePath(directory: string): string {
    return join(directory, VOLUME_METADATA_DIRECTORY, "volume-state.json");
  }

  async #writeState(directory: string, state: VolumeState): Promise<void> {
    const target = this.#statePath(directory);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #readState(directory: string): Promise<VolumeState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.#statePath(directory), "utf8")) as unknown;
      if (
        !isRecord(value) ||
        value.schemaVersion !== 2 ||
        typeof value.tenantId !== "string" ||
        typeof value.workspaceId !== "string" ||
        typeof value.volumeId !== "string" ||
        typeof value.volumeGeneration !== "string" ||
        !VOLUME_GENERATION_PATTERN.test(value.volumeGeneration)
      )
        return undefined;
      const expectedKeys = [
        "schemaVersion",
        "tenantId",
        "workspaceId",
        "volumeId",
        "volumeGeneration",
        ...(value.forkedFrom === undefined ? [] : ["forkedFrom"]),
      ];
      if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")) return undefined;
      if (
        value.forkedFrom !== undefined &&
        (!isRecord(value.forkedFrom) ||
          typeof value.forkedFrom.workspaceId !== "string" ||
          typeof value.forkedFrom.settlementRevision !== "string" ||
          !SHA256_PATTERN.test(value.forkedFrom.settlementRevision))
      )
        return undefined;
      return value as unknown as VolumeState;
    } catch {
      return undefined;
    }
  }

  async #withVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const run = () => this.#withLocalVolumeLock(volumeId, operation);
    return this.#distributedLock === undefined
      ? run()
      : this.#distributedLock.withLock(volumeId, run);
  }

  async #writeSettlementRevision(directory: string, revision: string): Promise<void> {
    const target = join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_SETTLEMENT_FILE);
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temporary, `${revision}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #readSettlementRevision(directory: string): Promise<string | undefined> {
    try {
      const value = (
        await readFile(join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_SETTLEMENT_FILE), "utf8")
      ).trim();
      return SHA256_PATTERN.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async #browseTarget(
    directory: string,
    rootPathValue: string,
    pathValue: string,
    pathMayBeEmpty: boolean,
  ): Promise<{ absolute: string; relative: string }> {
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
    return { absolute, relative: path };
  }

  async #withVolumeLocks<T>(volumeIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(volumeIds)].sort();
    const acquireLocal = (index: number): Promise<T> => {
      const volumeId = ordered[index];
      return volumeId === undefined
        ? operation()
        : this.#withLocalVolumeLock(volumeId, () => acquireLocal(index + 1));
    };
    if (this.#distributedLock?.withLocks !== undefined) {
      return this.#distributedLock.withLocks(ordered, () => acquireLocal(0));
    }
    const acquire = (index: number): Promise<T> => {
      const volumeId = ordered[index];
      return volumeId === undefined
        ? operation()
        : this.#withVolumeLock(volumeId, () => acquire(index + 1));
    };
    return acquire(0);
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
