import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";

/** Provider call IDs can repeat in later responses. Display, cancellation and
 * reply transport use the native Tool task ID, scoped by physical Session. */
export class DurableToolIdentities {
  #assistant: number | undefined;
  readonly #calls = new Map<string, number>();
  constructor(readonly storage: Storage) {}
  async resolve(callId: string, assistant?: EntryRecord, result?: EntryRecord): Promise<string> {
    if (result?.byTaskId !== undefined) {
      const task = await this.storage.task(result.byTaskId, BACKGROUND_CONTEXT);
      if (task?.kind === "pi.tool") return `task:${task.id}`;
      // Unoffered/invalid calls can be settled directly by their generation.
      return `entry:${result.id}`;
    }
    if (!assistant) throw new Error("Native Tool start has no calling assistant entry");
    if (this.#assistant !== assistant.id || !this.#calls.has(callId)) {
      this.#assistant = assistant.id;
      this.#calls.clear();
      const count =
        assistant.model?.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((part) => part.type === "toolCall")
            : [],
        ).length ?? 0;
      const tasks = await this.storage.scanTasks(
        { kind: "pi.tool", conversationId: assistant.conversationId },
        Math.max(1, count),
        { after: assistant.id },
        BACKGROUND_CONTEXT,
      );
      for (const task of tasks.items) {
        const input = task.input as { assistant?: number; callId?: string };
        if (input.assistant === assistant.id && input.callId)
          this.#calls.set(input.callId, task.id);
      }
    }
    const id = this.#calls.get(callId);
    if (!id) throw new Error("Native Tool start has no task identity");
    return `task:${id}`;
  }
}
