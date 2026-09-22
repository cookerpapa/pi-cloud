import { beforeEach, expect, it, vi } from "vitest";
import type { KafkaJS } from "@confluentinc/kafka-javascript";

const f = vi.hoisted(() => ({
  committed: "3",
  high: "5",
  stale: false,
  commit: vi.fn(),
  consumers: 0,
  logger: undefined as KafkaJS.Logger | undefined,
  batch: undefined as ((payload: KafkaJS.EachBatchPayload) => Promise<void>) | undefined,
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    CODES: { ERRORS: { ERR__ASSIGN_PARTITIONS: 1 } },
    KafkaJS: {
      logLevel: { NOTHING: 0 },
      Kafka: class {
        admin() {
          return {
            async connect() {},
            async disconnect() {},
            async fetchTopicOffsets() {
              return [{ partition: 0, low: "0", high: f.high }];
            },
            async fetchOffsets() {
              return [{ partitions: [{ partition: 0, offset: f.committed }] }];
            },
          };
        }
        consumer(options: {
          kafkaJS: { autoCommit: boolean; logger: KafkaJS.Logger };
          rebalance_cb: (...args: unknown[]) => Promise<void>;
        }) {
          expect(options.kafkaJS.autoCommit).toBe(false);
          f.consumers++;
          f.logger = options.kafkaJS.logger;
          return {
            async connect() {
              await options.rebalance_cb({ code: 1 }, [{ topic: "log", partition: 0 }], {
                assign() {},
                unassign() {},
              });
            },
            async subscribe() {},
            async disconnect() {},
            pause() {},
            seek() {},
            resume() {},
            async run(options: { eachBatch: typeof f.batch }) {
              f.batch = options.eachBatch;
            },
            commitOffsets: f.commit,
          };
        }
      },
    },
  },
}));
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";

beforeEach(() => {
  f.committed = "3";
  f.high = "5";
  f.stale = false;
  f.batch = undefined;
  f.consumers = 0;
  f.logger = undefined;
  f.commit.mockReset().mockResolvedValue(undefined);
});
async function fixture() {
  const effects: number[] = [],
    projected: number[] = [];
  const consumer = new KafkaLogConsumer<{ command: boolean; n: number }>({
    brokers: ["fake"],
    topic: "log",
    groupId: "group",
    clientId: "test",
    groupRecovery: true,
    orderedEffects: true,
    replayOffsets: async () => new Map([[0, 0n]]),
    decode: (value) => JSON.parse(value.toString()),
    handler: async ({ fact }, _current, commit) => {
      projected.push(fact.n);
      if (fact.command && (await commit!())) effects.push(fact.n);
    },
  });
  await consumer.start();
  await consumer.waitUntilAssigned(1000);
  await vi.waitFor(() => expect(f.batch).toBeDefined());
  const deliver = (entries: Array<[number, boolean]>) =>
    f.batch!({
      batch: {
        topic: "log",
        partition: 0,
        messages: entries.map(([n, command]) => ({
          offset: String(n),
          value: Buffer.from(JSON.stringify({ n, command })),
        })),
      },
      isStale: () => f.stale,
      resolveOffset() {},
    } as unknown as KafkaJS.EachBatchPayload);
  return { consumer, effects, projected, deliver };
}

it("replays an unfinished display prefix without executing commands below the committed dispatch boundary", async () => {
  const test = await fixture();
  try {
    await test.deliver([
      [0, false],
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(test.projected).toEqual([0, 1, 2, 3, 4]);
    expect(test.effects).toEqual([3]);
    expect(f.commit.mock.calls.map(([offsets]) => offsets[0].offset)).toEqual(["4"]);
  } finally {
    await test.consumer.close();
  }
});
it("does not move commit backwards while rebuilding memory", async () => {
  const test = await fixture();
  try {
    await test.deliver([
      [0, false],
      [1, true],
    ]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(test.effects).toEqual([]);
  } finally {
    await test.consumer.close();
  }
});

it("does not add a synchronous commit for every text fragment", async () => {
  const test = await fixture();
  try {
    for (let n = 3; n < 103; n++) await test.deliver([[n, false]]);
    expect(f.commit).toHaveBeenCalledOnce();
    await test.deliver([[103, true]]);
    expect(f.commit.mock.calls.at(-1)![0][0].offset).toBe("104");
    expect(test.effects).toEqual([103]);
  } finally {
    await test.consumer.close();
  }
});
it("cannot dispatch before commit acknowledgement", async () => {
  const test = await fixture();
  let confirm!: () => void;
  f.commit.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
  );
  try {
    const pending = test.deliver([[3, true]]);
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledOnce());
    expect(test.effects).toEqual([]);
    confirm();
    await pending;
    expect(test.effects).toEqual([3]);
  } finally {
    await test.consumer.close();
  }
});
it("a lost commit acknowledgement cannot start an effect", async () => {
  const test = await fixture();
  f.commit.mockRejectedValueOnce(new Error("commit acknowledgement lost"));
  try {
    await test.deliver([[3, true]]);
    expect(test.effects).toEqual([]);
  } finally {
    await test.consumer.close();
  }
});
it("rebalance invalidates a continuation that just obtained commit acknowledgement", async () => {
  const test = await fixture();
  f.commit.mockImplementationOnce(async () => {
    f.stale = true;
  });
  try {
    await test.deliver([[3, true]]);
    expect(test.effects).toEqual([]);
  } finally {
    await test.consumer.close();
  }
});

it("surfaces a background client error and reconstructs the consumer instead of silently hanging", async () => {
  const test = await fixture();
  try {
    f.logger!.error("Consumer encountered error while consuming: Unknown topic");
    expect(() => test.consumer.checkHealth()).toThrow("unhealthy");
    await vi.waitFor(() => expect(f.consumers).toBe(2), { timeout: 2000 });
    await test.consumer.waitUntilAssigned(1000);
    await test.deliver([[3, true]]);
    expect(test.effects).toEqual([3]);
  } finally {
    await test.consumer.close();
  }
});
