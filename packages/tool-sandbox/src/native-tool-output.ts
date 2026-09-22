import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  sanitizeBinaryOutput,
  truncateTail,
} from "@earendil-works/pi-agent-core";
import { StringDecoder } from "node:string_decoder";

export function redactToolText(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s@/]+(@[^\s]+)/giu, "$1[PI_CLOUD_REDACTED]$2")
    .replace(/\b(?:glpat|gldt|glcbt|glptt)-[A-Za-z0-9._~-]{8,}\b/gu, "[PI_CLOUD_REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, "[PI_CLOUD_REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, "[PI_CLOUD_REDACTED]");
}

/** Pi's public tail truncator at the data source; no full-output artifact store. */
export class NativeToolOutput {
  readonly #decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  readonly #maximumBytes: number;
  #tail = "";
  #bytes = 0;
  #newlines = 0;
  #openLine = false;

  constructor(maximumBytes = DEFAULT_MAX_BYTES) {
    this.#maximumBytes = Math.min(maximumBytes, DEFAULT_MAX_BYTES);
  }
  append(stream: "stdout" | "stderr", bytes: Buffer): void {
    this.#append(this.#decoders[stream].write(bytes));
  }
  finish(): void {
    this.#append(this.#decoders.stdout.end());
    this.#append(this.#decoders.stderr.end());
  }
  #append(value: string): void {
    const text = sanitizeBinaryOutput(value).replace(/\r/g, "");
    if (!text) return;
    this.#bytes += Buffer.byteLength(text);
    this.#newlines += text.split("\n").length - 1;
    this.#openLine = !text.endsWith("\n");
    const bytes = Buffer.from(this.#tail + text);
    let start = Math.max(0, bytes.byteLength - this.#maximumBytes * 2);
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
    this.#tail = bytes.subarray(start).toString("utf8");
  }
  snapshot() {
    const tail = truncateTail(redactToolText(this.#tail), {
      maxBytes: this.#maximumBytes,
      maxLines: DEFAULT_MAX_LINES,
    });
    const totalLines = this.#newlines + Number(this.#openLine);
    const truncated = this.#bytes > this.#maximumBytes || totalLines > DEFAULT_MAX_LINES;
    const truncation = {
      ...tail,
      truncated,
      truncatedBy: truncated
        ? (tail.truncatedBy ??
          (this.#bytes > this.#maximumBytes ? ("bytes" as const) : ("lines" as const)))
        : null,
      totalLines,
      totalBytes: this.#bytes,
    };
    return {
      content: [{ type: "text" as const, text: tail.content }],
      details: truncated ? { truncation } : undefined,
    };
  }
  result(emptyText = "(no output)") {
    const result = this.snapshot();
    let text = result.content[0]!.text || emptyText;
    if (result.details)
      text +=
        "\n\n[Output truncated to the bounded tail; omitted output is not archived. Redirect large output to a file when needed. Do not rerun commands with uncertain side effects to recover output.]";
    return { ...result, content: [{ type: "text" as const, text }] };
  }
}
