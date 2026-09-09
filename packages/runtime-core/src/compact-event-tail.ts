import type { PiCloudEvent } from "@pi-cloud/protocol";

type Span = { event: PiCloudEvent; first: number; bytes: number; envelopeBytes: number };
const utf8 = new TextEncoder();

/** Disposable presentation spans, never re-published as original Kafka facts. */
export class CompactEventTail {
  #spans: Span[] = [];
  #ids = new Map<number, string>();
  #covered = 0;
  #high = 0;
  get highWaterMark() {
    return Math.max(this.#high, this.#covered);
  }
  get coveredThrough() {
    return this.#covered;
  }
  get size() {
    return this.#spans.length;
  }
  get bytes() {
    return this.#spans.reduce((n, s) => n + s.bytes, 0);
  }
  get events() {
    return this.#spans.map((s) => s.event);
  }

  accept(event: PiCloudEvent): boolean {
    if (event.seq <= this.#covered) return false;
    const prior = this.#ids.get(event.seq);
    if (prior !== undefined) {
      if (prior !== event.eventId) throw new Error("Conflicting events in Session projection");
      return false;
    }
    this.#ids.set(event.seq, event.eventId);
    this.#high = Math.max(this.#high, event.seq);
    const text = event.type === "assistant.text.delta" ? event.payload.text : undefined;
    const envelopeBytes = utf8.encode(
      JSON.stringify(text === undefined ? event : { ...event, payload: { text: "" } }),
    ).byteLength;
    const span = {
      event,
      first: event.seq,
      bytes: envelopeBytes + (text === undefined ? 0 : utf8.encode(text).byteLength),
      envelopeBytes,
    };
    let at = this.#spans.length;
    if (at && this.#spans[at - 1]!.event.seq > event.seq) {
      let lo = 0,
        hi = at;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.#spans[mid]!.event.seq < event.seq) lo = mid + 1;
        else hi = mid;
      }
      at = lo;
    }
    this.#spans.splice(at, 0, span);
    if (at > 0 && this.#merge(at - 1)) at--;
    this.#merge(at);
    return true;
  }
  #merge(at: number): boolean {
    const left = this.#spans[at],
      right = this.#spans[at + 1];
    if (
      !left ||
      !right ||
      left.event.type !== "assistant.text.delta" ||
      right.event.type !== "assistant.text.delta" ||
      left.event.turnId !== right.event.turnId ||
      left.event.sessionId !== right.event.sessionId ||
      left.event.seq + 1 !== right.first
    )
      return false;
    this.#spans.splice(at, 2, {
      event: {
        ...right.event,
        payload: { text: left.event.payload.text + right.event.payload.text },
      },
      first: left.first,
      bytes: left.bytes + right.bytes - left.envelopeBytes,
      envelopeBytes: right.envelopeBytes,
    });
    return true;
  }
  cover(through: number): void {
    this.#covered = Math.max(this.#covered, through);
    this.#spans = this.#spans.filter((s) => s.event.seq > this.#covered);
    for (const seq of this.#ids.keys()) if (seq <= this.#covered) this.#ids.delete(seq);
  }
  text(): string {
    return this.#spans
      .flatMap((s) => (s.event.type === "assistant.text.delta" ? [s.event.payload.text] : []))
      .join("");
  }
}
