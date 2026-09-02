import { MAX_WORKSPACE_BLOB_BYTES, type WorkspaceBlob } from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { parseWorkspaceVolumeSettlement } from "./workspace-volume-settlement.ts";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const MAX_WORKSPACE_SEED_FILES = 512;
export const MAX_WORKSPACE_SEED_FILE_BYTES = 512 * 1_024;
export const MAX_WORKSPACE_SEED_PATH_BYTES = 512;
export const MAX_WORKSPACE_SEED_BYTES = 2 * 1_024 * 1_024;

type WorkspaceSeedFile = {
  path: string;
  executable: boolean;
  sizeBytes: number;
  sha256: string;
  content: string;
};

export type WorkspaceSeedFileContent = {
  path: string;
  executable: boolean;
  content: Buffer;
};

function seedError(message: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(message);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_SEED_PATH_BYTES ||
    posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    segments[0] !== ".git-credentials"
  );
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw seedError("Workspace file content is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw seedError("Workspace file content is not canonical base64");
  }
  return decoded;
}

export function parseWorkspaceSeed(seed: Uint8Array): WorkspaceSeedFileContent[] {
  if (parseWorkspaceVolumeSettlement(seed) !== undefined) {
    throw seedError("Provider Workspace settlement does not contain portable file bytes");
  }
  if (seed.byteLength < 1 || seed.byteLength > MAX_WORKSPACE_SEED_BYTES) {
    throw seedError("Workspace seed is outside its byte limit");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(seed);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw seedError("Workspace seed is not valid UTF-8 JSON");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["format", "files"]) ||
    parsed.format !== "pi-cloud.workspace-seed.v1" ||
    !Array.isArray(parsed.files) ||
    parsed.files.length > MAX_WORKSPACE_SEED_FILES
  ) {
    throw seedError("Workspace seed shape is invalid");
  }

  const restored: WorkspaceSeedFileContent[] = [];
  const paths = new Set<string>();
  for (const candidate of parsed.files) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["path", "executable", "sizeBytes", "sha256", "content"]) ||
      typeof candidate.path !== "string" ||
      !validRelativePath(candidate.path) ||
      typeof candidate.executable !== "boolean" ||
      !Number.isSafeInteger(candidate.sizeBytes) ||
      (candidate.sizeBytes as number) < 0 ||
      (candidate.sizeBytes as number) > MAX_WORKSPACE_SEED_FILE_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
      typeof candidate.content !== "string" ||
      paths.has(candidate.path)
    ) {
      throw seedError("Workspace file entry is invalid");
    }
    const content = decodeCanonicalBase64(candidate.content);
    if (content.byteLength !== candidate.sizeBytes || sha256(content) !== candidate.sha256) {
      throw seedError("Workspace file content does not match its metadata");
    }
    paths.add(candidate.path);
    restored.push({ path: candidate.path, executable: candidate.executable, content });
  }
  restored.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < restored.length - 1; index += 1) {
    const current = restored[index];
    const next = restored[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw seedError("Workspace seed contains a file/directory collision");
    }
  }
  return restored;
}

export function createWorkspaceSeed(
  files: readonly {
    path: string;
    executable: boolean;
    content: Uint8Array;
  }[],
): Uint8Array {
  if (files.length > MAX_WORKSPACE_SEED_FILES) {
    throw seedError("Workspace contains too many files for this seed format");
  }
  const paths = new Set<string>();
  const entries: WorkspaceSeedFile[] = files.map((file) => {
    if (
      !validRelativePath(file.path) ||
      typeof file.executable !== "boolean" ||
      file.content.byteLength > MAX_WORKSPACE_SEED_FILE_BYTES ||
      paths.has(file.path)
    ) {
      throw seedError("Workspace file entry is invalid");
    }
    paths.add(file.path);
    const content = Buffer.from(file.content);
    return {
      path: file.path,
      executable: file.executable,
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      content: content.toString("base64"),
    };
  });
  entries.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < entries.length - 1; index += 1) {
    const current = entries[index];
    const next = entries[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw seedError("Workspace seed contains a file/directory collision");
    }
  }
  const encoded = Buffer.from(
    `${JSON.stringify({ format: "pi-cloud.workspace-seed.v1", files: entries })}\n`,
    "utf8",
  );
  if (encoded.byteLength > MAX_WORKSPACE_SEED_BYTES) {
    throw seedError("Workspace seed is outside its byte limit");
  }
  validateWorkspacePayload(encoded);
  return encoded;
}

export async function restoreWorkspaceSeed(
  workspaceDirectory: string,
  seed: Uint8Array,
): Promise<void> {
  const restored = parseWorkspaceSeed(seed);
  for (const entry of await readdir(workspaceDirectory)) {
    if (entry === ".git-credentials") continue;
    await rm(resolve(workspaceDirectory, entry), { recursive: true, force: true });
  }
  for (const file of restored) {
    const target = resolve(workspaceDirectory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
    await chmod(target, file.executable ? 0o755 : 0o644);
  }
}

export function validateWorkspacePayload(seed: Uint8Array): void {
  if (parseWorkspaceVolumeSettlement(seed) !== undefined) return;
  parseWorkspaceSeed(seed);
}

export function encodeWorkspaceBlob(seed: Uint8Array): WorkspaceBlob {
  validateWorkspacePayload(seed);
  return {
    encoding: "base64",
    sha256: sha256(seed),
    sizeBytes: seed.byteLength,
    data: Buffer.from(seed).toString("base64"),
  };
}

export function decodeWorkspaceBlob(blob: WorkspaceBlob): Uint8Array {
  const bytes = decodeCanonicalBase64(blob.data);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_WORKSPACE_BLOB_BYTES ||
    bytes.byteLength !== blob.sizeBytes ||
    sha256(bytes) !== blob.sha256
  ) {
    throw seedError("Workspace blob does not match its envelope");
  }
  validateWorkspacePayload(bytes);
  return bytes;
}
