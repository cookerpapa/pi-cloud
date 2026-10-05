export const PI_CODING_AGENT_REVISION_ID = "b8770920-7434-4daf-ad3e-ded45368764f";

export type AgentRuntimeKind = "pi_sdk";
export type SessionStorageKind = "pi_durable_storage_v1";

export type AgentRevisionSnapshot = Readonly<{
  revisionId: string;
  definitionKey: string;
  runtimeKind: AgentRuntimeKind;
  runtimeVersion: string;
  harnessVersion: string;
  sessionStorageKind: SessionStorageKind;
}>;
