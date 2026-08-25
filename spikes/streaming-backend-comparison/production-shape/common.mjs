import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import pg from "pg";

export const STREAM_NAME = "PICLOUD_EVENTS";
export const SUBJECT_PREFIX = "pc.events";
export const NATS_SERVERS = [
  "nats://127.0.0.1:14231",
  "nats://127.0.0.1:14232",
  "nats://127.0.0.1:14233",
];
export const DATABASE_URL =
  "postgresql://pi_cloud_streaming_spike:local-spike-only-password@127.0.0.1:15434/pi_cloud_streaming_spike";
export const INGEST_TOKEN = "production-shape-ingest-token";
export const BROWSER_TOKEN = "production-shape-browser-token";

export function sessionSubject(sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new TypeError("Session ID is invalid");
  return `${SUBJECT_PREFIX}.${sessionId}`;
}

export function encode(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decode(value) {
  const parsed = JSON.parse(new TextDecoder().decode(value));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.eventId !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.attemptId !== "string" ||
    !Number.isSafeInteger(parsed.fence) ||
    !Number.isSafeInteger(parsed.seq) ||
    typeof parsed.type !== "string" ||
    typeof parsed.payload !== "object" ||
    parsed.payload === null
  ) {
    throw new Error("Production-shape event is invalid");
  }
  return parsed;
}

export function createPool(max = 20) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max });
  pool.on("error", () => undefined);
  return pool;
}

export async function connectJetStream(name) {
  const connection = await connect({ servers: NATS_SERVERS, name, maxReconnectAttempts: -1 });
  return {
    connection,
    jetstream: jetstream(connection),
    manager: await jetstreamManager(connection),
  };
}

export async function initializeDatabase(pool) {
  await pool.query(`
    create table if not exists spike_sessions (
      session_id text primary key,
      tenant_id text not null,
      attempt_id text not null,
      fence bigint not null,
      state text not null check (state in ('active', 'settled'))
    );
    create table if not exists spike_canonical_messages (
      event_id text primary key,
      session_id text not null references spike_sessions(session_id),
      turn_id text not null,
      content text not null,
      stream_sequence bigint not null,
      created_at timestamptz not null default now()
    );
    create table if not exists spike_terminal_turns (
      event_id text primary key,
      session_id text not null references spike_sessions(session_id),
      turn_id text not null,
      state text not null,
      stream_sequence bigint not null,
      created_at timestamptz not null default now()
    );
    create table if not exists spike_projector_state (
      singleton boolean primary key default true check (singleton),
      stream_sequence bigint not null
    );
    insert into spike_projector_state(singleton, stream_sequence)
    values (true, 0)
    on conflict (singleton) do nothing;
  `);
}

export async function resetDatabase(pool) {
  await pool.query(`
    truncate spike_canonical_messages, spike_terminal_turns, spike_sessions cascade;
    update spike_projector_state set stream_sequence = 0 where singleton = true;
  `);
}

export function createEvent({
  sessionId,
  attemptId,
  fence,
  seq,
  type = "assistant.text.delta",
  payload = { text: `chunk-${String(seq)}` },
  turnId = `turn-${sessionId}`,
}) {
  return {
    schemaVersion: 1,
    eventId: `${sessionId}:${attemptId}:${String(seq)}:${type}`,
    sessionId,
    attemptId,
    fence,
    turnId,
    seq,
    type,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

export async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error("Condition did not become true before timeout");
}
