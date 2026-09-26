export const PI_CODING_AGENT_REVISION_ID = "84041f7b-5052-4abf-8bfd-16adf083c67e";

export type AgentRuntimeKind = "pi_sdk";
export type SessionStorageKind = "pi_session_storage_v1";

export type AgentRevisionSnapshot = Readonly<{
  revisionId: string;
  definitionKey: string;
  runtimeKind: AgentRuntimeKind;
  runtimeVersion: string;
  harnessVersion: string;
  sessionStorageKind: SessionStorageKind;
}>;
