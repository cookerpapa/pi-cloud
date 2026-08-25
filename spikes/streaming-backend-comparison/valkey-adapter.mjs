import { createClient } from "redis";
import { createCollector, decodeEvent } from "./workload.mjs";

function streamKey(runId, sessionId) {
  return `pc:stream:${runId}:${sessionId}`;
}

function fields(entry) {
  const values = entry[1];
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] === "event") return decodeEvent(values[index + 1]);
  }
  throw new Error("Valkey Stream entry omitted its event field");
}

export class ValkeyAdapter {
  name = "valkey";
  acknowledgement = "XADD reply, AOF everysec, single primary in this experiment";
  gatewayState = "Direct per-Session XREAD; projector must discover dynamic Stream keys";
  #runId;
  #sessions;
  #client;
  #projectorClient;
  #projectorStop = false;

  constructor(runId, sessions) {
    this.#runId = runId;
    this.#sessions = sessions;
    this.#client = createClient({ url: "redis://127.0.0.1:16380" });
    this.#projectorClient = this.#client.duplicate();
    this.#client.on("error", () => undefined);
    this.#projectorClient.on("error", () => undefined);
  }

  async setup() {
    await Promise.all([this.#client.connect(), this.#projectorClient.connect()]);
    for (const sessionId of this.#sessions) {
      await this.#client.sendCommand([
        "XGROUP",
        "CREATE",
        streamKey(this.#runId, sessionId),
        "projector",
        "0-0",
        "MKSTREAM",
      ]);
    }
  }

  async publish(value) {
    try {
      await this.#client.sendCommand([
        "XADD",
        streamKey(this.#runId, value.sessionId),
        `${String(value.seq)}-0`,
        "event",
        JSON.stringify(value),
      ]);
      return { duplicate: false };
    } catch (error) {
      if (error instanceof Error && error.message.includes("equal or smaller")) {
        return { duplicate: true };
      }
      throw error;
    }
  }

  async startProjector(expectedEvents) {
    const collector = createCollector(expectedEvents);
    const keys = this.#sessions.map((sessionId) => streamKey(this.#runId, sessionId));
    this.#projectorStop = false;
    const run = (async () => {
      while (!this.#projectorStop) {
        const response = await this.#projectorClient.sendCommand([
          "XREADGROUP",
          "GROUP",
          "projector",
          "projector-1",
          "COUNT",
          "512",
          "BLOCK",
          "250",
          "STREAMS",
          ...keys,
          ...keys.map(() => ">"),
        ]);
        if (response === null) continue;
        for (const [key, entries] of Object.entries(response)) {
          for (const entry of entries) {
            const value = fields(entry);
            collector.observe(value);
          }
          if (entries.length > 0) {
            await this.#projectorClient.sendCommand([
              "XACK",
              key,
              "projector",
              ...entries.map((entry) => entry[0]),
            ]);
          }
        }
      }
    })().catch((error) => collector.fail(error));
    return {
      completion: collector.completion,
      result: () => collector.result(),
      close: async () => {
        this.#projectorStop = true;
        await this.#projectorClient.disconnect().catch(() => undefined);
        await run.catch(() => undefined);
      },
    };
  }

  async replaySession(sessionId) {
    const response = await this.#client.sendCommand([
      "XRANGE",
      streamKey(this.#runId, sessionId),
      "-",
      "+",
    ]);
    const sequences = new Map([[sessionId, []]]);
    const deliveryLatenciesMs = [];
    for (const entry of response) {
      const value = fields(entry);
      sequences.get(sessionId).push(value.seq);
      deliveryLatenciesMs.push(
        Number(process.hrtime.bigint() - BigInt(value.emittedNs)) / 1_000_000,
      );
    }
    return { sequences, deliveryLatenciesMs, scannedRecords: response.length };
  }

  async reconnect() {
    if (this.#client.isOpen) await this.#client.disconnect();
    this.#client = createClient({ url: "redis://127.0.0.1:16380" });
    this.#client.on("error", () => undefined);
    await this.#client.connect();
  }

  async close({ removeData = false } = {}) {
    if (removeData && this.#client.isOpen) {
      await this.#client.sendCommand([
        "DEL",
        ...this.#sessions.map((sessionId) => streamKey(this.#runId, sessionId)),
      ]);
    }
    if (this.#projectorClient.isOpen)
      await this.#projectorClient.disconnect().catch(() => undefined);
    if (this.#client.isOpen) await this.#client.disconnect().catch(() => undefined);
  }
}
