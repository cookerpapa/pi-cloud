import type { Database } from "@pi-cloud/database";
import { parsePiCloudEvent } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import type { KafkaLiveSessionTail } from "./kafka-live-session-tail.ts";
import type {
  PrepareTerminalTurnProjectionInput,
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

export class LiveTailTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #database: Kysely<Database>;
  readonly #events: Pick<KafkaLiveSessionTail, "readTurn">;

  constructor(options: {
    database: Kysely<Database>;
    events: Pick<KafkaLiveSessionTail, "readTurn">;
  }) {
    this.#database = options.database;
    this.#events = options.events;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const boundary = await this.#database
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", "attempt.id", "run.current_attempt_id")
      .innerJoin("session_leases as authority", (join) =>
        join
          .onRef("authority.attempt_id", "=", "attempt.id")
          .onRef("authority.run_id", "=", "run.id"),
      )
      .select("authority.last_event_seq as lastEventSequence")
      .where("run.tenant_id", "=", input.tenantId)
      .where("run.session_id", "=", input.sessionId)
      .where("run.turn_id", "=", input.turnId)
      .where("run.command_id", "=", input.commandId)
      .executeTakeFirst();
    if (boundary === undefined) throw new Error("Terminal projection RunAttempt is unavailable");
    const expectedSequence = Number(boundary.lastEventSequence);
    const deadline = Date.now() + 10_000;
    let events = this.#events.readTurn(input.tenantId, input.sessionId, input.turnId);
    while ((events.at(-1)?.seq ?? 0) < expectedSequence && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      events = this.#events.readTurn(input.tenantId, input.sessionId, input.turnId);
    }
    if (events.length === 0) throw new Error("No accepted Kafka live prefix is available");
    const previousSequence = events.at(-1)?.seq ?? 0;
    if (previousSequence !== expectedSequence) {
      throw new Error("Accepted Kafka live prefix has not reached the RunAttempt boundary");
    }
    const terminalEvent = parsePiCloudEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      seq: previousSequence + 1,
      occurredAt: input.occurredAt,
      ...input.body,
    });
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript: projectConversationTurnTranscript([...events, terminalEvent]),
    };
  }
}
