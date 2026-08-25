import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import { STREAM_NAME, connectJetStream, createPool, decode } from "./common.mjs";

const pool = createPool(8);
const runtime = await connectJetStream("pi-cloud-production-shape-projector");
const durableName = "PG_PROJECTOR";
try {
  await runtime.manager.consumers.info(STREAM_NAME, durableName);
} catch {
  await runtime.manager.consumers.add(STREAM_NAME, {
    durable_name: durableName,
    ack_policy: AckPolicy.Explicit,
    ack_wait: 1_000_000_000,
    deliver_policy: DeliverPolicy.All,
    filter_subject: "pc.events.>",
    max_ack_pending: 20_000,
    num_replicas: 3,
  });
}
const consumer = await runtime.jetstream.consumers.get(STREAM_NAME, durableName);
const messages = await consumer.consume();
process.send?.({ type: "ready" });

let closing = false;
async function close() {
  closing = true;
  await messages.close().catch(() => undefined);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

try {
  for await (const message of messages) {
    if (closing) break;
    const value = decode(message.data);
    const streamSequence = message.info.streamSequence;
    if (value.type === "assistant.message.completed") {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into spike_canonical_messages(event_id, session_id, turn_id, content, stream_sequence)
           values ($1, $2, $3, $4, $5)
           on conflict (event_id) do nothing`,
          [value.eventId, value.sessionId, value.turnId, value.payload.content, streamSequence],
        );
        await client.query(
          "update spike_projector_state set stream_sequence = greatest(stream_sequence, $1) where singleton = true",
          [streamSequence],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      process.send?.({ type: "committed", eventId: value.eventId, streamSequence });
      if (process.env.PAUSE_AFTER_COMMIT_EVENT === value.eventId) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    } else if (value.type === "turn.completed") {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into spike_terminal_turns(event_id, session_id, turn_id, state, stream_sequence)
           values ($1, $2, $3, 'completed', $4)
           on conflict (event_id) do nothing`,
          [value.eventId, value.sessionId, value.turnId, streamSequence],
        );
        await client.query(
          "update spike_projector_state set stream_sequence = greatest(stream_sequence, $1) where singleton = true",
          [streamSequence],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      process.send?.({ type: "terminal", eventId: value.eventId, streamSequence });
    }
    message.ack();
  }
} finally {
  await messages.close().catch(() => undefined);
  await runtime.connection.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
