import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import type { AcceptedWorkFinishedFact } from "../../runtime-core/src/accepted-fact.ts";
import { MemoryStorage, type StorageWrite, type Seq, type Id } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurablePostgresProjection } from "@pi-cloud/pi-session-postgres/durable";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type {
  AcceptedTurnResource,
  NativeInputCommand,
  NativeInputResult,
} from "@pi-cloud/protocol";
import { DurableAgentSession } from "../../sandbox-supervisor/src/durable/agent-session.ts";
import { DurableHumanInputs } from "../../sandbox-supervisor/src/durable/human-inputs.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import { TurnExecutionCancelledError } from "@pi-cloud/runtime-core/run-executor";

/** Real Pi native commits + real PG projection. No provider, VM or Kafka is simulated as proven here. */
export async function startNativeInputAgent(
  database: Kysely<Database>,
  tenantId: string,
  accepted: AcceptedTurnResource,
) {
  const session = await database
    .selectFrom("sessions")
    .select(["pi_session_id", "pi_conversation_id"])
    .where("id", "=", accepted.sessionId)
    .executeTakeFirstOrThrow();
  const projection = new DurablePostgresProjection(database, {
    tenantId,
    sessionId: session.pi_session_id,
  });
  let sequence = 0,
    highWater = 1;
  const writes: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async mintId<I extends Id<string>>(): Promise<I> {
      const id = await super.mintId<I>();
      highWater = Math.max(highWater, Number(id) + 1);
      return id;
    }
    override async commit(batch: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(batch);
      const origins = prepared.writes.flatMap((write) =>
        "value" in write
          ? [
              {
                recordId: write.value.id,
                sessionId: accepted.sessionId,
                runId: accepted.runId,
                turnId: accepted.turnId,
              },
            ]
          : [],
      );
      await projection.apply(
        { seq: prepared.seq, nextId: highWater, writes: prepared.writes },
        origins,
        { topic: "native-input-fixture", partition: 0, offset: BigInt(prepared.seq) },
      );
      writes.push([...prepared.writes]);
      sequence = prepared.seq;
      return prepared.apply();
    }
  })();
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 }),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    ...Array.from({ length: 80 }, (_, i) => fauxAssistantMessage(`answer ${i}`)),
  ]);
  const toolEntered = Promise.withResolvers<void>(),
    toolGate = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const runtime = await DurableAgentSession.open(storage, {
    models,
    remoteTools: [],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  let accepting = true,
    aborted = false;
  const calls: string[] = [];
  const conversation = await runtime.bind({
    runId: accepted.runId,
    conversationId: Number(session.pi_conversation_id),
    model: faux.getModel(),
    agent: {},
    context: { sessionId: accepted.sessionId, turnId: accepted.turnId },
    remoteTools: () => [],
    tools: [
      {
        name: "hold",
        description: "Test gate",
        parameters: Type.Object({}),
        execute: async () => {
          toolEntered.resolve();
          await toolGate.promise;
          return { content: [{ type: "text", text: "released" }] };
        },
      },
    ],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw new Error("Unexpected remote Tool");
    },
    openModel: async ({ input, options }) => {
      calls.push(JSON.stringify(input));
      return { model: faux.getModel(), options, release: () => {} };
    },
  });
  const inputs = new DurableHumanInputs({
    conversation,
    runId: accepted.runId,
    storage,
    sequence: () => sequence,
    assertCurrent: async () => {},
    accepting: () => accepting,
    prepare: async (text) => text,
  });
  const worker = await createTestWorker(database);
  const entered = Promise.withResolvers<void>(),
    exited = Promise.withResolvers<void>();
  let reference = "",
    completion: AcceptedWorkFinishedFact | undefined;
  const projectCompletion = async () => {
    if (!completion) return;
    await database
      .transaction()
      .execute((tx) => projection.checkpointLiveIn(tx, projection.liveState.fork()));
    await new ExecutionStreamProjector(database).project({
      fact: completion,
      topic: "native-input-fixture",
      partition: 0,
      offset: BigInt(sequence + 1),
    });
  };
  const execution = worker
    .executor({
      finish: async (fact) => {
        completion = { ...fact, nativeSequence: sequence };
      },
      execute: async (request, listener, admission) => {
        reference = admission.executionReference;
        if (request.input.kind !== "prompt") throw new Error("Input fixture requires chat work");
        await conversation.submit(
          { type: "input", content: request.input.prompt, requestId: accepted.runId },
          BACKGROUND_CONTEXT,
        );
        await toolEntered.promise;
        entered.resolve();
        await finish.promise;
        if (aborted) {
          listener.executionExited();
          exited.resolve();
          throw new TurnExecutionCancelledError("user_request", false);
        }
        return { stopReason: "stop" };
      },
    })
    .dispatchRun(accepted.runId);
  void execution.catch((error) => entered.reject(error));
  await entered.promise;
  let serial = Promise.resolve();
  const backend = {
    humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
      if (
        command.runId !== accepted.runId ||
        command.sessionId !== accepted.sessionId ||
        command.tenantId !== tenantId ||
        command.executionReference !== reference
      )
        return Promise.reject(new Error("Wrong owner"));
      const result = serial.then(() =>
        command.action === "submit"
          ? inputs.submit(command.input)
          : inputs.mutate(command.mutation),
      );
      serial = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  const release = async () => {
    toolGate.resolve();
    await conversation.waitForIdle(
      withAbortSignal(AbortSignal.timeout(10_000), BACKGROUND_CONTEXT),
    );
  };
  return {
    backend,
    inputs,
    conversation,
    runtime,
    storage,
    writes,
    worker,
    reference,
    calls,
    execution,
    projectCompletion,
    release,
    async abort() {
      await new RunCancellationExecutor({
        database,
        executionAuthority: worker.coordinator,
        backend: {
          cancel: async (request, listener) => {
            await listener.started({ executionReference: reference });
            accepting = false;
            aborted = true;
            const result = conversation.abort(BACKGROUND_CONTEXT);
            toolGate.resolve();
            await result;
            finish.resolve();
            await exited.promise;
            return { reason: request.reason, forced: false };
          },
        },
      }).dispatchTargetRun(accepted.runId);
      await execution;
    },
    async close() {
      accepting = false;
      toolGate.resolve();
      await runtime.close();
      finish.resolve();
      await execution;
      await projectCompletion();
    },
  };
}
