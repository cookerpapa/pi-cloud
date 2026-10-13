import {
  parsePiCloudEvent,
  parseDurableTextDescription,
  parsePathProbe,
  parseSessionControlChange,
  parseToolCancellation,
  parseDurableSessionCommit,
  durableToolIntent,
} from "@pi-cloud/protocol";
import type { AcceptedFact, SessionLogFact } from "./accepted-fact.ts";
import { toolCommandsForFact, controlToolsForFact } from "./tool-invocation-fact.ts";
export {
  ACCEPTED_FACT_TOPIC,
  loadProducerCapacity,
  type ProducerCapacity,
} from "@pi-cloud/event-log";

export function kafkaProducerLane(sessionId: string, lanes: number): number {
  if (!Number.isSafeInteger(lanes) || lanes < 1) throw new TypeError("Invalid partition count");
  const laneCount = lanes;
  let hash = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % laneCount;
}

export function parseKafkaAcceptedFact(value: string | Buffer): AcceptedFact {
  return parseAcceptedFact(JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value));
}

export function parseSessionLogFact(value: string | Buffer): SessionLogFact {
  const parsed = JSON.parse(value.toString());
  return parsed?.kind === "control_change"
    ? parseSessionControlChange(parsed)
    : parseAcceptedFact(parsed);
}

export function parseAcceptedFact(value: unknown): AcceptedFact {
  const parsed = value as AcceptedFact;
  if (parsed.kind === "durable_commit") {
    const commit = parseDurableSessionCommit(parsed.commit);
    for (const tool of parsed.tools)
      if (tool.target !== "control") durableToolIntent(commit, tool.taskId);
    toolCommandsForFact(parsed);
    controlToolsForFact(parsed);
    return {
      ...parsed,
      commit,
      display: parsed.display.map((display) => {
        if (
          display.coveredThrough !== undefined &&
          (!Number.isSafeInteger(display.coveredThrough) || display.coveredThrough < 0)
        )
          throw new Error("Invalid native display coverage");
        return { ...display, texts: display.texts.map(parseDurableTextDescription) };
      }),
      cancellations: parsed.cancellations.map(parseToolCancellation),
    };
  }
  if (parsed.kind === "agent_event") {
    return { ...parsed, event: parsePiCloudEvent(parsed.event) };
  }
  if (parsed.kind === "path_probe") return parsePathProbe(parsed);
  if (parsed.kind === "tool_cancel") return parseToolCancellation(parsed);
  if (parsed.kind === "execution_seal") {
    if (parsed.closesWriter !== true) throw new Error("Only Session writer seals are supported");
    return parsed;
  }
  if (parsed.kind === "work_finished") {
    if (
      parsed.retireWriter !== true ||
      !Number.isSafeInteger(parsed.nativeSequence) ||
      parsed.nativeSequence < 0 ||
      !Number.isSafeInteger(parsed.baseSequence) ||
      parsed.baseSequence < 0
    )
      throw new Error("Invalid work completion boundary");
    parsePiCloudEvent({
      schemaVersion: 1,
      eventId: parsed.factId,
      sessionId: parsed.scope.sessionId,
      turnId: parsed.scope.turnId,
      agentId: parsed.agentId,
      seq: parsed.baseSequence + 1,
      occurredAt: parsed.occurredAt,
      ...parsed.terminal,
    });
    return parsed;
  }

  throw new TypeError("Kafka AcceptedFact kind is invalid");
}
