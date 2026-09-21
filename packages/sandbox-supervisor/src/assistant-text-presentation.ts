import type { AssistantMessagePhase } from "@pi-cloud/protocol";
import type { AssistantTextPhaseResolver } from "./agent-turn-runtime.ts";
import type { CloudAgentRuntimeEvent } from "./cloud-agent-runtime.ts";

/** Display-only selection. Original messages/signatures still enter native storage. */
export class AssistantTextPresentation {
  #nextTextItem = 0;
  readonly #phases = new Map<number, AssistantMessagePhase>();
  constructor(readonly resolvePhase?: AssistantTextPhaseResolver) {}

  present(event: CloudAgentRuntimeEvent): CloudAgentRuntimeEvent | undefined {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.#nextTextItem = 0;
      this.#phases.clear();
    }
    if (event.type !== "message_update") return event;
    const stream = event.assistantMessageEvent;
    if (stream.type === "text_start") {
      const index = this.#nextTextItem++;
      const phase =
        stream.partial.responseId === undefined
          ? undefined
          : this.resolvePhase?.(stream.partial.responseId, index);
      if (phase !== undefined) this.#phases.set(stream.contentIndex, phase);
      return event;
    }
    if (stream.type !== "text_delta" && stream.type !== "text_end") return event;
    const phase = this.#phases.get(stream.contentIndex);
    if (stream.type === "text_delta" && phase === "commentary") return undefined;
    if (stream.type === "text_end") {
      this.#phases.delete(stream.contentIndex);
      if (phase !== "commentary") return event;
      // Use Pi's authoritative completed block, not a second text accumulator.
      return {
        ...event,
        assistantMessageEvent: Object.assign(
          {
            type: "text_delta" as const,
            contentIndex: stream.contentIndex,
            delta: stream.content,
            partial: stream.partial,
          },
          { presentationPhase: phase },
        ),
      };
    }
    return phase === undefined
      ? event
      : {
          ...event,
          assistantMessageEvent: Object.assign({}, stream, { presentationPhase: phase }),
        };
  }
}
