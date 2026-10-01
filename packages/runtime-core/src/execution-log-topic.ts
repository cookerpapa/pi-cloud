import { Admin, ConfigResourceTypes } from "@platformatic/kafka";
import { ACCEPTED_FACT_TOPIC } from "@pi-cloud/event-log";

export type ExecutionLogTopicOptions = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic?: string;
  partitions: number;
  replicas: number;
  manageTopic?: boolean;
}>;

export class ExecutionLogTopic {
  readonly #admin: Admin;
  readonly #topic: string;
  readonly #partitions: number;
  readonly #replicas: number;
  readonly #manageTopic: boolean;
  #started = false;
  constructor(options: ExecutionLogTopicOptions) {
    if (!options.brokers.length || options.brokers.some((s) => !s.trim()))
      throw new TypeError("Kafka brokers are invalid");
    for (const n of [options.partitions, options.replicas])
      if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("Invalid topic sizing");
    this.#topic = options.topic ?? ACCEPTED_FACT_TOPIC;
    this.#partitions = options.partitions;
    this.#replicas = options.replicas;
    this.#manageTopic = options.manageTopic !== false;
    this.#admin = new Admin({
      clientId: `${options.clientId}-log-policy`,
      bootstrapBrokers: [...options.brokers],
      autocreateTopics: false,
    });
  }
  async start(): Promise<void> {
    if (this.#started) throw new Error("Execution log topic can only start once");
    const configs = [
      { name: "cleanup.policy", value: "delete" },
      { name: "retention.ms", value: "-1" },
      { name: "retention.bytes", value: "-1" },
      { name: "message.timestamp.type", value: "LogAppendTime" },
      { name: "min.insync.replicas", value: String(Math.max(1, this.#replicas - 1)) },
    ];
    const topics = this.#manageTopic ? await this.#admin.listTopics() : [this.#topic];
    if (this.#manageTopic && !topics.includes(this.#topic)) {
      await this.#admin.createTopics({
        topics: [this.#topic],
        partitions: this.#partitions,
        replicas: this.#replicas,
        configs,
      });
    }
    const metadata = await this.#admin.metadata({ topics: [this.#topic], forceUpdate: true });
    const topic = metadata.topics.get(this.#topic);
    if (topic?.partitionsCount !== this.#partitions)
      throw new Error("AcceptedFact partition count cannot change within a topic generation");
    if (topic.partitions.some((partition) => partition.replicas.length !== this.#replicas))
      throw new Error("AcceptedFact topic replication does not match configured replicas");
    const described = await this.#admin.describeConfigs({
      resources: [
        {
          resourceType: ConfigResourceTypes.TOPIC,
          resourceName: this.#topic,
          configurationKeys: configs.map(({ name }) => name),
        },
      ],
    });
    const actual = new Map(
      described
        .find((resource) => resource.resourceName === this.#topic)
        ?.configs.map(({ name, value }) => [name, value]),
    );
    for (const config of configs) {
      if (actual.get(config.name) !== config.value)
        throw new Error(`AcceptedFact topic ${config.name} must be ${config.value}`);
    }
    this.#started = true;
  }

  async checkHealth(): Promise<void> {
    if (!this.#started || !(await this.#admin.listTopics()).includes(this.#topic))
      throw new Error("Execution log topic is unavailable");
  }
  async close(): Promise<void> {
    this.#started = false;
    await this.#admin.close();
  }
}
