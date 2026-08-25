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

function infoNumber(value, name) {
  const line = value.split("\n").find((candidate) => candidate.startsWith(`${name}:`));
  if (line === undefined) throw new Error(`Valkey INFO omitted ${name}`);
  const parsed = Number(line.slice(name.length + 1).trim());
  if (!Number.isFinite(parsed)) throw new Error(`Valkey INFO ${name} is invalid`);
  return parsed;
}

async function boundedBatches(values, size, operation) {
  for (let offset = 0; offset < values.length; offset += size) {
    await Promise.all(values.slice(offset, offset + size).map(operation));
  }
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
  #appendFsync;

  constructor(runId, sessions, appendFsync = "everysec") {
    if (appendFsync !== "everysec" && appendFsync !== "always") {
      throw new TypeError("Valkey appendfsync mode is invalid");
    }
    this.name = `valkey-aof-${appendFsync}`;
    this.acknowledgement =
      appendFsync === "always"
        ? "XADD reply with AOF appendfsync always, single primary in this experiment"
        : "XADD reply with AOF appendfsync everysec, single primary in this experiment";
    this.#appendFsync = appendFsync;
    this.#runId = runId;
    this.#sessions = sessions;
    this.#client = createClient({ url: "redis://127.0.0.1:16380" });
    this.#projectorClient = this.#client.duplicate();
    this.#client.on("error", () => undefined);
    this.#projectorClient.on("error", () => undefined);
  }

  async setup() {
    await Promise.all([this.#client.connect(), this.#projectorClient.connect()]);
    await this.#client.sendCommand(["CONFIG", "SET", "appendfsync", this.#appendFsync]);
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

  async measureIdleReaders(count) {
    const beforeClients = infoNumber(
      await this.#client.sendCommand(["INFO", "clients"]),
      "connected_clients",
    );
    const beforeMemory = infoNumber(
      await this.#client.sendCommand(["INFO", "memory"]),
      "used_memory",
    );
    const readers = Array.from({ length: count }, (_, index) => ({
      client: createClient({ url: "redis://127.0.0.1:16380" }),
      sessionId: `idle-${String(index).padStart(5, "0")}`,
      pending: undefined,
    }));
    const startedAt = performance.now();
    await boundedBatches(readers, 32, async (reader) => {
      reader.client.on("error", () => undefined);
      await reader.client.connect();
      reader.pending = reader.client
        .sendCommand([
          "XREAD",
          "BLOCK",
          "30000",
          "STREAMS",
          streamKey(this.#runId, reader.sessionId),
          "$",
        ])
        .catch(() => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const setupElapsedMs = performance.now() - startedAt;
    const afterClients = infoNumber(
      await this.#client.sendCommand(["INFO", "clients"]),
      "connected_clients",
    );
    const afterMemory = infoNumber(
      await this.#client.sendCommand(["INFO", "memory"]),
      "used_memory",
    );
    await boundedBatches(readers, 32, async (reader) => {
      if (reader.client.isOpen) await reader.client.disconnect().catch(() => undefined);
      await reader.pending;
    });
    return {
      readers: count,
      setupElapsedMs: Number(setupElapsedMs.toFixed(3)),
      brokerResources: afterClients - beforeClients,
      resourceUnit: "blocking client connections",
      gatewayOwnedSessionStates: 0,
      brokerMemoryDeltaBytes: afterMemory - beforeMemory,
      note: "The direct one-Stream-per-Session path consumes one blocking connection per ungrouped reader.",
    };
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
