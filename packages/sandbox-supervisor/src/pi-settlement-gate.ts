import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import type {
  AgentEvent,
  UserInput,
  Storage,
  Cursor,
  ConversationId,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { posix } from "node:path";
import { validMachineDirectory } from "@pi-cloud/protocol";

export const SETTLEMENT_GATE_COMMAND_ID = "settlement-gate" as const;
export const PI_SETTLEMENT_GATE_CUSTOM_TYPE = "pi-cloud.settlement_gate" as const;

export type PiSettlementGatePolicy = Readonly<{
  command: string;
  cwd: string;
  workingDirectory: string;
  timeoutMs: number;
  maximumFollowUps: 1;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedCommand(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isConfiguredVerification(command: string, policy: PiSettlementGatePolicy): boolean {
  const candidate = normalizedCommand(command);
  const verification = normalizedCommand(policy.command);
  if (policy.cwd === "." && candidate === verification) return true;
  const absolute = posix.resolve(policy.workingDirectory, policy.cwd);
  return [policy.cwd, absolute].some((path) => {
    const quoted = `'${path.replaceAll("'", "'\\''")}'`;
    const words = /^[A-Za-z0-9_./-]+$/.test(path) ? [path, quoted] : [quoted];
    return words.some((word) =>
      ["cd", "cd --"].some((cd) => candidate === `${cd} ${word} && ${verification}`),
    );
  });
}

export function settlementGatePolicyFromCommand(
  command: ExecuteTurnCommandMessage,
): PiSettlementGatePolicy | undefined {
  const configured = command.payload.environment.recipe.verificationCommands.find(
    (candidate) => candidate.id === SETTLEMENT_GATE_COMMAND_ID,
  );
  if (configured === undefined) return undefined;
  return Object.freeze({
    command: configured.command,
    cwd: configured.cwd,
    workingDirectory: command.payload.workingDirectory,
    timeoutMs: configured.timeoutMs,
    maximumFollowUps: 1,
  });
}

function validatePolicy(policy: PiSettlementGatePolicy): PiSettlementGatePolicy {
  if (
    policy.maximumFollowUps !== 1 ||
    policy.command.trim().length === 0 ||
    policy.command.length > 4_096 ||
    !/^(?:\.|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/u.test(policy.cwd) ||
    !validMachineDirectory(policy.workingDirectory) ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 100 ||
    policy.timeoutMs > 300_000
  ) {
    throw new TypeError("Pi settlement gate policy is invalid");
  }
  return Object.freeze({ ...policy });
}

/** Produces at most one project verification reminder; never executes a Tool. */
export class PiSettlementGateController {
  readonly #policy: PiSettlementGatePolicy;
  readonly #verificationCalls = new Map<string, number>();
  readonly #mutatingCalls = new Set<string>();
  #mutationObserved = false;
  #mutationRevision = 0;
  #verifiedRevision = -1;
  #lastStopReason: string | undefined;
  #used = false;

  constructor(input: PiSettlementGatePolicy) {
    this.#policy = validatePolicy(input);
  }

  observe(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      // Native call IDs may be reused by a later Assistant response.
      this.#verificationCalls.delete(event.toolCallId);
      if (!["write", "edit", "bash"].includes(event.toolName)) return;
      this.#mutationObserved = true;
      this.#mutationRevision++;
      if (
        event.toolName === "bash" &&
        isRecord(event.args) &&
        typeof event.args.command === "string" &&
        isConfiguredVerification(event.args.command, this.#policy)
      ) {
        this.#verificationCalls.set(event.toolCallId, this.#mutationRevision);
      } else this.#mutatingCalls.add(event.toolCallId);
      return;
    }
    if (event.type === "tool_execution_end") {
      const revision = this.#verificationCalls.get(event.toolCallId);
      this.#verificationCalls.delete(event.toolCallId);
      // A mutation that was already running when verification started can
      // change bytes afterwards, including a partially failed write/shell.
      if (this.#mutatingCalls.delete(event.toolCallId)) this.#mutationRevision++;
      if (
        revision === this.#mutationRevision &&
        event.entry?.model?.some((message) => message.role === "toolResult" && !message.isError) &&
        this.#mutatingCalls.size === 0
      )
        this.#verifiedRevision = revision;
      return;
    }
    if (event.type === "message_end") {
      const reason = event.entry.model?.find((message) => message.role === "assistant")?.stopReason;
      if (typeof reason === "string") this.#lastStopReason = reason;
    }
  }

  prepareFollowUp(): UserInput | undefined {
    if (
      this.#used ||
      !this.#mutationObserved ||
      this.#verifiedRevision === this.#mutationRevision ||
      this.#lastStopReason === undefined ||
      this.#lastStopReason === "error" ||
      this.#lastStopReason === "aborted"
    ) {
      return undefined;
    }
    this.#used = true;
    const cwd = posix.resolve(this.#policy.workingDirectory, this.#policy.cwd);
    return [
      {
        type: "text",
        text: [
          "A project-defined verification step is still required before this Run settles.",
          `Run the configured command from ${cwd}, inspect its result, and address any failure before the final response.`,
          `Command: ${this.#policy.command}`,
          `Timeout: ${String(Math.ceil(this.#policy.timeoutMs / 1_000))} seconds`,
        ].join("\n"),
      },
    ];
  }
}

/** Evaluate committed native progress at Pi's yield boundary. Lossy display
 * delivery cannot decide whether verification ran, and a replacement Worker
 * reaches the same decision without a second progress document or ledger. */
export async function prepareNativeSettlementFollowUp(input: {
  policy: PiSettlementGatePolicy;
  storage: Storage;
  conversationId: number;
  afterEntry?: number | undefined;
  answer: AssistantMessage;
}): Promise<UserInput | undefined> {
  const controller = new PiSettlementGateController(input.policy);
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await input.storage.scanEntries(
      {
        conversationId: input.conversationId as ConversationId,
        ...(input.afterEntry === undefined
          ? {}
          : { minEntryId: (input.afterEntry + 1) as EntryId }),
      },
      256,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const reminder = "A project-defined verification step is still required before this Run settles.";
  for (const entry of entries.reverse())
    for (const message of entry.model ?? []) {
      // Native onYield continuations are written by their generation. Human
      // submissions have no byTaskId, and therefore cannot consume this reminder.
      if (
        message.role === "user" &&
        entry.byTaskId !== undefined &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "text" && part.text.startsWith(reminder))
      )
        return undefined;
      if (message.role === "assistant") {
        controller.observe({ type: "message_end", entry });
        for (const call of message.content)
          if (call.type === "toolCall")
            controller.observe({
              type: "tool_execution_start",
              toolCallId: call.id,
              toolName: call.name,
              args: JSON.parse(JSON.stringify(call.arguments)),
            });
      } else if (message.role === "toolResult")
        controller.observe({
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          entry,
        });
    }
  controller.observe({
    type: "message_end",
    entry: {
      id: 0 as EntryId,
      conversationId: input.conversationId as ConversationId,
      kind: "pi.assistant",
      model: [input.answer],
    },
  });
  return controller.prepareFollowUp();
}
