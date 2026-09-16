import { randomUUID } from "node:crypto";
import { Admin } from "@platformatic/kafka";
import { expect, it } from "vitest";
import { KafkaAcceptedFactBus } from "../src/kafka-accepted-fact.ts";

const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!brokers)(
  "checks the actual Kafka topic policy before publishing",
  async () => {
    const prefix = `pi-cloud.audit-policy-${randomUUID()}`;
    const admin = new Admin({
      clientId: prefix,
      bootstrapBrokers: brokers!,
      autocreateTopics: false,
    });
    const created: string[] = [];
    try {
      const cases = [
        { name: "valid", override: {}, replicas: 3 },
        { name: "replicas", override: {}, replicas: 1 },
        ...Object.entries({
          "cleanup.policy": "compact",
          "retention.ms": "3600000",
          "retention.bytes": "1024",
          "message.timestamp.type": "CreateTime",
          "min.insync.replicas": "1",
        }).map(([name, value]) => ({ name, override: { [name]: value }, replicas: 3 })),
      ];
      for (const [index, scenario] of cases.entries()) {
        const topic = `${prefix}-${index}`;
        await admin.createTopics({
          topics: [topic],
          partitions: 1,
          replicas: scenario.replicas,
          configs: Object.entries({
            "cleanup.policy": "delete",
            "retention.ms": "-1",
            "retention.bytes": "-1",
            "message.timestamp.type": "LogAppendTime",
            "min.insync.replicas": "2",
            ...scenario.override,
          }).map(([name, value]) => ({ name, value })),
        });
        created.push(topic);
        const bus = new KafkaAcceptedFactBus({
          brokers: brokers!,
          clientId: `${prefix}-${index}`,
          topic,
          partitions: 1,
          replicas: 3,
          producerLanes: 1,
          manageTopic: false,
        });
        try {
          if (scenario.name === "valid") await expect(bus.start()).resolves.toBeUndefined();
          else await expect(bus.start()).rejects.toThrow(scenario.name);
        } finally {
          await bus.close();
        }
      }
    } finally {
      try {
        if (created.length) await admin.deleteTopics({ topics: created });
      } finally {
        await admin.close();
      }
    }
  },
  60_000,
);
