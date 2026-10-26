import {
  KafkaLogConsumer,
  type KafkaLogConsumerOptions,
  type KafkaLogRecord,
} from "@pi-cloud/event-log";
import type { AcceptedFact } from "./accepted-fact.ts";
import type { AcceptedToolCommand, AcceptedToolCancellation } from "@pi-cloud/protocol";
import { parseKafkaAcceptedFact } from "./kafka-accepted-fact.ts";

export type KafkaAcceptedFactRecord = KafkaLogRecord<AcceptedFact>;
export type KafkaToolDispatchRecord = KafkaLogRecord<
  | AcceptedFact
  | AcceptedToolCommand
  | AcceptedToolCancellation
  | import("@pi-cloud/protocol").AcceptedExecutorToolCommand
>;

export class KafkaAcceptedFactConsumer extends KafkaLogConsumer<AcceptedFact> {
  constructor(options: Omit<KafkaLogConsumerOptions<AcceptedFact>, "decode">) {
    super({ ...options, decode: parseKafkaAcceptedFact });
  }
}
