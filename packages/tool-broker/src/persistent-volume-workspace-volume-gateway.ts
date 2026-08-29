import { captureWorkspaceIndex } from "@pi-cloud/workspace-runtime";
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
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  SHA256_PATTERN,
  UUID_PATTERN,
  VOLUME_GENERATION_FILE,
  VOLUME_GENERATION_PATTERN,
  VOLUME_METADATA_DIRECTORY,
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
  type WorkspaceVolumeGatewayMaterializeInput,
  type WorkspaceVolumeGatewayDeleteInput,
  type WorkspaceVolumeGatewayForkInput,
  type WorkspaceVolumeGatewayPrepareInput,
  type WorkspaceVolumeGatewaySnapshotInput,
  type WorkspaceVolumeGatewaySourceCredentialAuthorizeInput,
  type WorkspaceVolumeGatewaySourceCredentialPreflightInput,
  type WorkspaceVolumeGitRunner,
} from "./workspace-volume-gateway-contract.ts";

const GIT_TIMEOUT_MS = 5 * 60_000;

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
    const origin = new URL(credential.cloneUrl).origin;
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

  async snapshot(input: WorkspaceVolumeGatewaySnapshotInput): Promise<{
    volumeRevision: string;
    files: Awaited<ReturnType<typeof captureWorkspaceIndex>>["files"];
  }> {
    const identity = validatedIdentity(input);
    if (
      !UUID_PATTERN.test(input.activationId) ||
      !Number.isSafeInteger(input.fencingToken) ||
      input.fencingToken < 1 ||
      !SHA256_PATTERN.test(input.bindingSha256)
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_capture_fence_invalid",
        "Workspace capture fence was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const state = (await this.#readState(directory))!;
      const index = await captureWorkspaceIndex(join(directory, VOLUME_WORKSPACE_DIRECTORY));
      const volumeRevision = this.#volumeRevision(state.volumeGeneration, index.files);
      return {
        volumeRevision,
        files: index.files,
      };
    });
  }

  async fork(input: WorkspaceVolumeGatewayForkInput): Promise<{
    sourceRevision: string;
    volumeRevision: string;
    files: Awaited<ReturnType<typeof captureWorkspaceIndex>>["files"];
  }> {
    if (!SHA256_PATTERN.test(input.expectedSourceRevision)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_fork_revision_invalid",
        "Workspace fork source revision was invalid",
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
      const sourceState = (await this.#readState(sourceDirectory))!;
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
          existingState.forkedFrom?.workspaceId !== source.workspaceId
        ) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_target_conflict",
            "Workspace fork target was already bound to another source",
            false,
          );
        }
        const existingIndex = await captureWorkspaceIndex(
          join(targetDirectory, VOLUME_WORKSPACE_DIRECTORY),
        );
        return {
          sourceRevision: existingState.forkedFrom.volumeRevision,
          volumeRevision: this.#volumeRevision(existingGeneration, existingIndex.files),
          files: existingIndex.files,
        };
      }
      const sourceIndex = await captureWorkspaceIndex(
        join(sourceDirectory, VOLUME_WORKSPACE_DIRECTORY),
      );
      const sourceRevision = this.#volumeRevision(sourceState.volumeGeneration, sourceIndex.files);
      if (sourceRevision !== input.expectedSourceRevision) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_fork_source_changed",
          "Workspace changed before the isolated fork was captured",
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
        await this.#writeState(temporary, {
          schemaVersion: 2,
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          volumeId: target.volumeId,
          volumeGeneration,
          forkedFrom: { workspaceId: source.workspaceId, volumeRevision: sourceRevision },
        });
        const copiedIndex = await captureWorkspaceIndex(
          join(temporary, VOLUME_WORKSPACE_DIRECTORY),
        );
        if (JSON.stringify(copiedIndex.files) !== JSON.stringify(sourceIndex.files)) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_copy_invalid",
            "Isolated Workspace copy did not match its source revision",
            false,
          );
        }
        await rm(targetDirectory, { recursive: true, force: true });
        await rename(temporary, targetDirectory);
        return {
          sourceRevision,
          volumeRevision: this.#volumeRevision(volumeGeneration, copiedIndex.files),
          files: copiedIndex.files,
        };
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async materialize(
    input: WorkspaceVolumeGatewayMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const identity = validatedIdentity(input);
    const path = safeRelativeFile(input.path);
    if (
      !SHA256_PATTERN.test(input.expectedSha256) ||
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 8 * 1_024 * 1_024
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_materialize_request_invalid",
        "Workspace materialize request was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const root = resolve(directory, VOLUME_WORKSPACE_DIRECTORY);
      const target = resolve(root, path);
      if (!target.startsWith(`${root}${sep}`)) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_materialize_path_invalid",
          "Workspace materialize path escaped its volume",
          false,
        );
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > input.maximumBytes) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_materialize_file_invalid",
            "Workspace materialized file was invalid",
            false,
          );
        }
        const bytes = await handle.readFile();
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== input.expectedSha256) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_revision_changed",
            "Workspace changed after the selected revision; refresh and retry",
            true,
          );
        }
        return { bytes, sha256 };
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
        credentialUrl = new URL((await readFile(credentialPath, "utf8")).trim());
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
        await this.#git(["ls-remote", input.userCloneUrl], {
          cwd: join(directory, VOLUME_WORKSPACE_DIRECTORY),
          credential: {
            provider: input.provider,
            cloneUrl: input.userCloneUrl,
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
          typeof value.forkedFrom.volumeRevision !== "string" ||
          !SHA256_PATTERN.test(value.forkedFrom.volumeRevision))
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

  #volumeRevision(
    volumeGeneration: string,
    files: readonly import("@pi-cloud/workspace-runtime").WorkspaceSnapshotFileMetadata[],
  ): string {
    return createHash("sha256")
      .update("pi-cloud.workspace-volume-revision.v1\0")
      .update(volumeGeneration)
      .update("\0")
      .update(JSON.stringify(files))
      .digest("hex");
  }
}
