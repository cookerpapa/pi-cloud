import type { RunActivityUpdate, RunPhase } from "@pi-cloud/protocol";
import type { CloudAgentRuntimeEvent } from "./cloud-agent-runtime.ts";

/** Only phase and time cross the trusted Runner boundary, never native payloads. */
export class PiRunActivity {
  readonly #tools = new Map<string, boolean>();
  #phase: RunPhase = "preparing";
  #cancelling = false;
  constructor(
    readonly publish: ((update: RunActivityUpdate) => void) | undefined,
    readonly clock: () => number = Date.now,
  ) {}

  phase(phase: RunPhase): void {
    if (this.#cancelling && phase !== "cancelling") return;
    this.#phase = phase;
    if (phase === "cancelling") this.#cancelling = true;
    try {
      this.publish?.({ phase, lastActivityAt: this.clock() });
    } catch {
      /* lossy observation */
    }
  }

  event(event: CloudAgentRuntimeEvent): void {
    switch (event.type) {
      case "agent_start":
      case "sampling_start":
        this.phase("waiting_model");
        break;
      case "message_update": {
        const type = event.assistantMessageEvent.type;
        if (type.startsWith("toolcall_")) this.phase("preparing_tool");
        else if (type.endsWith("_delta") || type.endsWith("_start")) this.phase("receiving_model");
        break;
      }
      case "tool_execution_start": {
        const args = event.args as { action?: unknown; reason?: unknown } | undefined;
        this.#tools.set(
          event.toolCallId,
          ((event.toolName === "subagent" || event.toolName === "subagent_supervisor") &&
            args?.action === "wait") ||
            (event.toolName === "subagent" && args?.action === "run") ||
            (event.toolName === "contact_supervisor" &&
              (args?.reason === "need_decision" || args?.reason === "interview_request")),
        );
        this.#toolPhase();
        break;
      }
      case "tool_execution_end":
        this.#tools.delete(event.toolCallId);
        if (this.#tools.size) this.#toolPhase();
        else this.phase("preparing");
        break;
      case "tool_execution_update":
        this.phase(this.#phase);
        break;
      case "compaction_start":
        this.phase("compacting");
        break;
      case "compaction_end":
        this.phase("preparing");
        break;
      case "auto_retry_start":
        this.phase("retrying");
        break;
      case "auto_retry_end":
        this.phase("preparing");
        break;
      case "agent_end":
        this.phase("settling");
        break;
    }
  }
  #toolPhase(): void {
    this.phase([...this.#tools.values()].every(Boolean) ? "waiting_child" : "executing_tool");
  }
}
