import {
  KafkaLogConsumer,
  type KafkaLogConsumerOptions,
  type KafkaLogRecord,
} from "@pi-cloud/event-log";
import type { AcceptedFact } from "./accepted-fact.ts";
import { parseKafkaAcceptedFact } from "./kafka-accepted-fact.ts";

export type KafkaAcceptedFactRecord = KafkaLogRecord<AcceptedFact>;

export class KafkaAcceptedFactConsumer extends KafkaLogConsumer<AcceptedFact> {
  constructor(options: Omit<KafkaLogConsumerOptions<AcceptedFact>, "decode">) {
    super({ ...options, decode: parseKafkaAcceptedFact });
  }
}
