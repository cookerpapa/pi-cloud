import { defineDoc, section } from "@earendil-works/pi-durable";
import { FORK_PROVENANCE_DOCUMENT, type ForkProvenance } from "@pi-cloud/protocol";

const ForkProvenanceDocument = defineDoc(FORK_PROVENANCE_DOCUMENT);

export function describeForkContext(origin: ForkProvenance, currentSessionId: string): string {
  return [
    `Current conversation: ${currentSessionId}.`,
    `This execution family (${origin.sessionId}) was forked from conversation ${origin.sourceSessionId} through entry ${origin.sourceEntryId}.`,
    "Only the selected agent's visible history was inherited, including results already returned to that history. The source family's agent instances, pending inputs, and separate subagent conversations were not inherited.",
    "Workspace files were not copied or rewound by this conversation fork.",
    "Agent IDs in inherited history are historical references, not live agents in this family. Use current-session agent information; create new subagents when needed and permitted. Do not wait for or send instructions to source agents on the assumption that they moved here.",
  ].join("\n");
}

export function forkContextSection(currentSession: (conversationId: number) => string | undefined) {
  return section("fork-context", async (input, context) => {
    const sessionId = currentSession(input.conversationId);
    if (!sessionId) return undefined;
    const state = await input.read.snapshot(ForkProvenanceDocument, context);
    return state?.origin ? describeForkContext(state.origin, sessionId) : undefined;
  });
}
