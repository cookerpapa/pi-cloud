import {
  MAX_WORKSPACE_BLOB_BYTES,
  type ExecuteTurnCommandMessage,
  type EnvironmentValidationReport,
  type WorkspaceBlob,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { PiTurnError } from "./pi-turn-runtime.ts";
import { validateWorkspacePayload } from "./workspace-seed.ts";

export type LoadedWorkspaceSettlement = {
  revision?: string;
  reference?: Uint8Array;
  workspaceRevision?: string;
};

export type CapturedWorkspaceSettlement = {
  reference: Uint8Array;
};

export type CapturedEnvironmentWorkspaceSettlement = CapturedWorkspaceSettlement & {
  environment: EnvironmentValidationReport;
};

export type SavedWorkspaceSettlement = {
  revision: string;
  workspaceRevision?: string;
};

export type CapturedToolOutput = {
  toolCallId: string;
  bytes: Uint8Array;
};

export type SavedToolOutputArtifact = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

export interface WorkspaceSettlementStore {
  load(command: ExecuteTurnCommandMessage): Promise<LoadedWorkspaceSettlement | undefined>;
  save(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    settlement: CapturedEnvironmentWorkspaceSettlement,
  ): Promise<SavedWorkspaceSettlement>;
  saveToolOutput?(
    command: ExecuteTurnCommandMessage,
    output: CapturedToolOutput,
  ): Promise<SavedToolOutputArtifact>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function settlementError(message: string): PiTurnError {
  return new PiTurnError("invalid_settlement", message, false);
}

function assertNonEmptyBounded(value: Uint8Array, maxBytes: number, description: string): void {
  if (value.byteLength < 1 || value.byteLength > maxBytes) {
    throw settlementError(`${description} is outside its byte limit`);
  }
}

function encodeBlob(bytes: Uint8Array, maxBytes: number, description: string): WorkspaceBlob {
  assertNonEmptyBounded(bytes, maxBytes, description);
  return {
    encoding: "base64",
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    data: Buffer.from(bytes).toString("base64"),
  };
}

function decodeBlob(blob: WorkspaceBlob, maxBytes: number, description: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.data)) {
    throw settlementError(`${description} is not canonical base64`);
  }
  const bytes = Buffer.from(blob.data, "base64");
  if (bytes.toString("base64") !== blob.data) {
    throw settlementError(`${description} is not canonical base64`);
  }
  assertNonEmptyBounded(bytes, maxBytes, description);
  if (bytes.byteLength !== blob.sizeBytes) {
    throw settlementError(`${description} length does not match its envelope`);
  }
  if (sha256(bytes) !== blob.sha256) {
    throw settlementError(`${description} hash does not match its envelope`);
  }
  return bytes;
}

export function encodeWorkspaceSettlement(reference: Uint8Array): WorkspaceBlob {
  validateWorkspacePayload(reference);
  return encodeBlob(reference, MAX_WORKSPACE_BLOB_BYTES, "Workspace settlement reference");
}

export function decodeWorkspaceSettlement(blob: WorkspaceBlob): Uint8Array {
  const reference = decodeBlob(blob, MAX_WORKSPACE_BLOB_BYTES, "Workspace settlement reference");
  validateWorkspacePayload(reference);
  return reference;
}

export function validateLoadedWorkspaceSettlement(
  settlement: LoadedWorkspaceSettlement | undefined,
): LoadedWorkspaceSettlement | undefined {
  if (settlement === undefined) return undefined;
  if (
    settlement.revision !== undefined &&
    (settlement.revision.length < 1 || settlement.revision.length > 256)
  ) {
    throw settlementError("Settlement revision is invalid");
  }
  if (
    settlement.revision === undefined &&
    (settlement.reference !== undefined || settlement.workspaceRevision !== undefined)
  ) {
    throw settlementError("Settlement revision is missing");
  }
  if (settlement.reference !== undefined) validateWorkspacePayload(settlement.reference);
  if (
    settlement.workspaceRevision !== undefined &&
    !/^[0-9a-f]{64}$/.test(settlement.workspaceRevision)
  ) {
    throw settlementError("Workspace settlement revision is invalid");
  }
  if (settlement.reference === undefined && settlement.workspaceRevision !== undefined) {
    throw settlementError("Workspace settlement metadata is incomplete");
  }
  if (settlement.reference !== undefined && settlement.workspaceRevision === undefined) {
    return {
      ...settlement,
      workspaceRevision: sha256(settlement.reference),
    };
  }
  return settlement;
}
