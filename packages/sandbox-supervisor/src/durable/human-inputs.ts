import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineDocFamily,
  InboxDoc,
  type Conversation,
  type InboxState,
  type Storage,
  type UserInput,
} from "@earendil-works/pi-durable";
import {
  NATIVE_HUMAN_INPUT_DOCUMENT,
  humanInputQueueRevisionMaterial,
  parseUserUploads,
  type NativeHumanInput,
  type NativeInputMutation,
  type NativeInputResult,
  type NativeInputSnapshot,
  type UserUpload,
} from "@pi-cloud/protocol";

type HumanInput = {
  idempotencyKey: string;
  fingerprint: string;
  text: string;
  uploads: JsonValue[];
  acceptedAt: string;
  revision: number;
  cancelled: boolean;
  nativeId: number | null;
};
export type HumanInputState = {
  runId: string;
  inputs: Record<string, HumanInput>;
  order: string[];
  receipts: Record<string, { fingerprint: string }>;
};
export const HumanInputDocument = defineDocFamily<HumanInputState, string>({
  kind: NATIVE_HUMAN_INPUT_DOCUMENT,
  version: 1,
  scope: "conversation",
  family: true,
  history: "latest",
  fork: "initial",
  initial: (runId) => ({ runId, inputs: {}, order: [], receipts: {} }),
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class NativeInputError extends Error {
  constructor(
    readonly code: "input_conflict" | "input_closed" | "idempotency_conflict",
    message: string,
  ) {
    super(message);
    this.name = "NativeInputError";
  }
}

export function humanQueueRevision(inbox: InboxState, state: HumanInputState): string {
  return createHash("sha256")
    .update(humanInputQueueRevisionMaterial(inbox.items, state.inputs))
    .digest("hex");
}

/** Queue membership and consumption belong to Pi; this stores editable UI metadata. */
export class DurableHumanInputs {
  constructor(
    readonly options: {
      conversation: Conversation;
      runId: string;
      storage: Storage;
      sequence(): number;
      assertCurrent(): Promise<void>;
      accepting(): boolean;
      prepare(text: string, uploads: readonly UserUpload[]): Promise<UserInput>;
    },
  ) {}

  #assertAccepting(): void {
    if (!this.options.accepting())
      throw new NativeInputError("input_closed", "The Run has closed input admission");
  }

  async submit(input: NativeHumanInput): Promise<NativeInputResult> {
    await this.options.assertCurrent();
    const { conversation, runId, storage } = this.options;
    let replayed = false;
    let acceptedAt = input.acceptedAt;
    await conversation.commit(async (tx) => {
      const state = await tx.doc(HumanInputDocument, conversation.id, runId, runId);
      const old = state.inputs[input.inputId];
      if (old) {
        if (old.fingerprint !== input.fingerprint || old.idempotencyKey !== input.idempotencyKey)
          throw new NativeInputError(
            "idempotency_conflict",
            "Input identity was used for another request",
          );
        replayed = true;
        acceptedAt = old.acceptedAt;
        return;
      }
      this.#assertAccepting();
      state.inputs[input.inputId] = {
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        text: input.text,
        uploads: clone(input.uploads) as unknown as JsonValue[],
        acceptedAt: input.acceptedAt,
        revision: 0,
        cancelled: false,
        nativeId: null,
      };
      state.order.push(input.inputId);
    }, BACKGROUND_CONTEXT);
    let submission = await storage.submissionByRequest(
      conversation.id,
      input.inputId,
      BACKGROUND_CONTEXT,
    );
    if (!submission) {
      this.#assertAccepting();
      const content = await this.options.prepare(input.text, input.uploads);
      this.#assertAccepting();
      const accepted = await conversation.submit(
        {
          type: "input",
          content,
          requestId: input.inputId,
          whenBusy: input.mode === "follow_up" ? "followUp" : "steer",
        },
        BACKGROUND_CONTEXT,
      );
      submission = await accepted.status(BACKGROUND_CONTEXT);
    }
    const nativeId = submission.id;
    await conversation.commit(async (tx) => {
      const state = await tx.doc(HumanInputDocument, conversation.id, runId, runId);
      state.inputs[input.inputId]!.nativeId = nativeId;
    }, BACKGROUND_CONTEXT);
    return { queue: await this.snapshot(), replayed, acceptedAt };
  }

  async mutate(mutation: NativeInputMutation): Promise<NativeInputResult> {
    await this.options.assertCurrent();
    const { conversation, runId } = this.options;
    const hash = mutation.fingerprint;
    const before = await this.#read();
    const prior = before.state.receipts[mutation.operationId];
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new NativeInputError("idempotency_conflict", "Edit identity was reused");
      return { queue: await this.snapshot(), replayed: true };
    }
    const current = before.state.inputs[mutation.inputId];
    if (!current) throw new NativeInputError("input_conflict", "Pending input was not found");
    const change = mutation.change;
    const uploads =
      change.action === "edit" && change.uploads !== undefined
        ? [...change.uploads]
        : parseUserUploads(current.uploads);
    const text =
      (change.action === "edit" || change.action === "steer") && change.text !== undefined
        ? change.text
        : current.text;
    const content =
      change.action === "edit" || (change.action === "steer" && change.text !== undefined)
        ? await this.options.prepare(text, uploads)
        : undefined;
    let replayed = false;
    await conversation.commit(async (tx) => {
      const submission = await tx.submissionByRequest(conversation.id, mutation.inputId);
      const state = await tx.doc(HumanInputDocument, conversation.id, runId, runId);
      const prior = state.receipts[mutation.operationId];
      if (prior) {
        if (prior.fingerprint !== hash)
          throw new NativeInputError("idempotency_conflict", "Edit identity was reused");
        replayed = true;
        return;
      }
      this.#assertAccepting();
      if (submission?.status !== "queued")
        throw new NativeInputError(
          "input_conflict",
          "The input has already been consumed or withdrawn",
        );
      const inbox = await tx.doc(InboxDoc, conversation.id);
      if (humanQueueRevision(inbox, state) !== mutation.revision)
        throw new NativeInputError(
          "input_conflict",
          "The pending queue changed; refresh before saving",
        );
      const index = inbox.items.findIndex((item) => item.id === submission.id);
      const item = inbox.items[index];
      const input = state.inputs[mutation.inputId];
      if (!item || item.mode === "write" || !input)
        throw new NativeInputError("input_conflict", "Pending input was not found");
      if (change.action === "cancel") {
        tx.settleSubmission(submission.id, { status: "unanswered", reason: "aborted" });
        inbox.items.splice(index, 1);
        input.cancelled = true;
        // Individual withdrawal has no Stop-return or transcript payload. Keep
        // identity/receipts so a lost reply cannot resurrect the old draft.
        input.text = "";
        input.uploads = [];
      } else if (change.action === "move") {
        const humanIds = new Set(Object.values(state.inputs).map((input) => input.nativeId));
        const positions = inbox.items.flatMap((item, index) =>
          humanIds.has(item.id) ? [index] : [],
        );
        const at = positions.indexOf(index);
        const otherIndex = positions[at + (change.direction === "up" ? -1 : 1)];
        if (otherIndex === undefined)
          throw new NativeInputError("input_conflict", "The input cannot move further");
        const other = inbox.items[otherIndex]!;
        inbox.items[index] = other;
        inbox.items[otherIndex] = item;
        const otherId = Object.keys(state.inputs).find(
          (id) => state.inputs[id]!.nativeId === other.id,
        )!;
        const left = state.order.indexOf(mutation.inputId),
          right = state.order.indexOf(otherId);
        [state.order[left], state.order[right]] = [otherId, mutation.inputId];
      } else {
        if (content !== undefined) {
          item.content = clone(content);
          input.text = text;
          input.uploads = clone(uploads) as unknown as JsonValue[];
        }
        if (change.action === "steer") item.mode = "steer";
      }
      input.revision++;
      state.receipts[mutation.operationId] = { fingerprint: hash };
    }, BACKGROUND_CONTEXT);
    return { queue: await this.snapshot(), replayed };
  }

  async #read(): Promise<{ state: HumanInputState; inbox: InboxState; nativeSequence: number }> {
    const { conversation, runId } = this.options;
    return conversation.commit(async (tx) => {
      const state = await tx.doc(HumanInputDocument, conversation.id, runId, runId);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      return { state: clone(state), inbox: clone(inbox), nativeSequence: this.options.sequence() };
    }, BACKGROUND_CONTEXT);
  }

  async snapshot(): Promise<NativeInputSnapshot> {
    const { state, inbox, nativeSequence } = await this.#read();
    const byNative = new Map(
      Object.entries(state.inputs).map(([id, input]) => [input.nativeId, { id, input }]),
    );
    const items = inbox.items
      .flatMap((item) => {
        const value = byNative.get(item.id);
        if (!value || item.mode === "write") return [];
        return [
          {
            inputId: value.id,
            idempotencyKey: value.input.idempotencyKey,
            text: value.input.text,
            uploads: parseUserUploads(value.input.uploads),
            acceptedAt: value.input.acceptedAt,
            mailboxPosition: 1,
            status: item.mode === "steer" ? ("steering" as const) : ("queued" as const),
          },
        ];
      })
      .map((item, index) => ({ ...item, mailboxPosition: index + 1 }));
    return {
      runId: this.options.runId,
      revision: humanQueueRevision(inbox, state),
      nativeSequence,
      hasMore: items.length > 20,
      items: items.slice(0, 20),
    };
  }
}
