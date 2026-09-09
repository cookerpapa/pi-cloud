import { stringifyChunked } from "@discoveryjs/json-ext";
import { SESSION_STREAM_PART_CHARACTERS, SESSION_STREAM_MAX_FRAME_BYTES } from "@pi-cloud/protocol";

function* parts(chunk: string): Generator<string> {
  for (let i = 0; i < chunk.length; i += SESSION_STREAM_PART_CHARACTERS)
    yield `event: stream.part\ndata: ${JSON.stringify(chunk.slice(i, i + SESSION_STREAM_PART_CHARACTERS))}\n\n`;
}

/** No whole-snapshot JSON string, application timer or acknowledgement. */
export function* sessionJsonFrames(
  value: unknown,
  kind: "snapshot" | "event",
  eventType?: string,
): Generator<string> {
  const chunks = stringifyChunked(value, { highWaterMark: SESSION_STREAM_PART_CHARACTERS });
  const first = chunks.next();
  if (kind === "event") {
    const second = chunks.next();
    if (
      second.done &&
      Buffer.byteLength(first.value as string) < SESSION_STREAM_MAX_FRAME_BYTES - 256
    ) {
      yield `event: ${eventType}\ndata: ${first.value}\n\n`;
      return;
    }
    yield `event: stream.begin\ndata: {"kind":"event"}\n\n`;
    if (!first.done) yield* parts(first.value);
    if (!second.done) yield* parts(second.value);
  } else {
    yield `event: stream.begin\ndata: {"kind":"snapshot"}\n\n`;
    if (!first.done) yield* parts(first.value);
  }
  for (const chunk of chunks) yield* parts(chunk);
  yield `event: stream.end\ndata: {}\n\n`;
}
