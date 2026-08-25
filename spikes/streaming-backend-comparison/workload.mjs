import { randomUUID } from "node:crypto";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function configuration() {
  const sessionCount = boundedInteger(
    process.env.PI_CLOUD_STREAM_BENCH_SESSIONS ?? "64",
    "sessions",
    2,
    512,
  );
  const eventsPerSession = boundedInteger(
    process.env.PI_CLOUD_STREAM_BENCH_EVENTS ?? "32",
    "events per Session",
    4,
    512,
  );
  const payloadBytes = boundedInteger(
    process.env.PI_CLOUD_STREAM_BENCH_PAYLOAD_BYTES ?? "256",
    "payload bytes",
    64,
    16_384,
  );
  const idleReaders = boundedInteger(
    process.env.PI_CLOUD_STREAM_BENCH_IDLE_READERS ?? "256",
    "idle readers",
    1,
    2_048,
  );
  return {
    sessionCount,
    eventsPerSession,
    payloadBytes,
    idleReaders,
    logicalEvents: sessionCount * eventsPerSession,
  };
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function sessions(count) {
  return Array.from({ length: count }, (_, index) => `session-${String(index).padStart(4, "0")}`);
}

export function event(sessionId, sequence, payloadBytes) {
  const fixed = JSON.stringify({ sessionId, sequence });
  return {
    schemaVersion: 1,
    eventId: `${sessionId}:${String(sequence)}`,
    sessionId,
    seq: sequence,
    emittedNs: process.hrtime.bigint().toString(),
    type: sequence % 11 === 0 ? "tool.completed" : "assistant.text.delta",
    payload: "x".repeat(Math.max(1, payloadBytes - Buffer.byteLength(fixed, "utf8"))),
  };
}

export function encodeEvent(value) {
  return encoder.encode(JSON.stringify(value));
}

export function decodeEvent(value) {
  const text =
    typeof value === "string"
      ? value
      : decoder.decode(Buffer.isBuffer(value) ? value : new Uint8Array(value));
  const parsed = JSON.parse(text);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.sessionId !== "string" ||
    !Number.isSafeInteger(parsed.seq) ||
    typeof parsed.emittedNs !== "string"
  ) {
    throw new Error("Streaming benchmark event is invalid");
  }
  return parsed;
}

export function deliveryLatencyMs(value) {
  return Number(process.hrtime.bigint() - BigInt(value.emittedNs)) / 1_000_000;
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summary(values) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
    maximum: Number(Math.max(...values, 0).toFixed(3)),
  };
}

export function createCollector(expectedEvents, timeoutMs = 30_000) {
  const sequences = new Map();
  const deliveryLatenciesMs = [];
  let scannedRecords = 0;
  let settled = false;
  let resolveComplete;
  let rejectComplete;
  const completion = new Promise((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  const timer = setTimeout(() => {
    if (!settled) rejectComplete(new Error("Streaming consumer timed out"));
  }, timeoutMs);
  timer.unref();

  return {
    completion,
    observe(value, delivered = true) {
      scannedRecords += 1;
      if (!delivered) return;
      const current = sequences.get(value.sessionId) ?? [];
      current.push(value.seq);
      sequences.set(value.sessionId, current);
      deliveryLatenciesMs.push(deliveryLatencyMs(value));
      const count = [...sequences.values()].reduce((total, items) => total + items.length, 0);
      if (count === expectedEvents && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveComplete();
      }
    },
    result() {
      return { sequences, deliveryLatenciesMs, scannedRecords };
    },
    fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectComplete(error);
    },
  };
}

export function verifyOrder(sequences, expectedPerSession) {
  const violations = [];
  for (const [sessionId, values] of sequences) {
    if (
      values.length !== expectedPerSession ||
      values.some((sequence, index) => sequence !== index + 1)
    ) {
      violations.push(sessionId);
    }
  }
  return violations;
}

export function uniqueName(prefix) {
  return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}
