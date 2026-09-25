import type { ConversationDetailResource, PiCloudEvent, ToolProgress } from "@pi-cloud/protocol";

/** Per-open-stream eligibility, reconstructed from the normal conversation snapshot. */
export class ToolProgressView {
  readonly #running = new Map<string, Map<string, { operationId?: string; revision: number }>>();
  constructor(conversation: ConversationDetailResource) {
    for (const turn of conversation.turns) {
      if (!["running", "cancelling"].includes(turn.state)) continue;
      for (const item of turn.transcript?.items ?? []) {
        if (item.kind === "tool" && item.status === "running")
          this.#start(turn.turnId, item.toolCallId);
      }
    }
  }
  #start(turnId: string, toolCallId: string) {
    let tools = this.#running.get(turnId);
    if (!tools) this.#running.set(turnId, (tools = new Map()));
    tools.set(toolCallId, { revision: 0 });
  }
  event(event: PiCloudEvent): void {
    if (event.turnId === null) return;
    if (event.type === "tool.started") this.#start(event.turnId, event.payload.toolCallId);
    else if (event.type === "tool.completed")
      this.#running.get(event.turnId)?.delete(event.payload.toolCallId);
    else if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))
      this.#running.delete(event.turnId);
  }
  accept(progress: ToolProgress): boolean {
    const tool = this.#running.get(progress.turnId)?.get(progress.toolCallId);
    if (
      !tool ||
      (tool.operationId && tool.operationId !== progress.operationId) ||
      progress.revision <= tool.revision
    )
      return false;
    tool.operationId = progress.operationId;
    tool.revision = progress.revision;
    return true;
  }
}
