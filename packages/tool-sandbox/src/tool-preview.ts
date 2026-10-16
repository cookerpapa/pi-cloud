import xterm from "@xterm/headless";
import type { Terminal } from "@xterm/headless";
import {
  boundedPreviewText,
  previewUpdate,
  TOOL_PREVIEW_RESET_MS,
  type ToolPreviewState,
  type ToolPreviewUpdate,
} from "@pi-cloud/protocol/guest";
import { redactToolText } from "./native-tool-output.ts";

const MAX_PENDING_BYTES = 256 * 1024;
const PARSE_CHUNK_BYTES = 32 * 1024;

/** A disposable display adapter. It never owns command flow control or results. */
export class TerminalToolPreview {
  #terminal: Terminal | undefined;
  #queue: Buffer[] = [];
  #pendingBytes = 0;
  #parsing = false;
  #closed = false;
  #unavailable = false;
  #seen = false;
  #dirty = false;
  #previous: ToolPreviewState | undefined;
  #lastReset = 0;
  #lastEmission = 0;
  #timer: NodeJS.Timeout;

  constructor(readonly emit: (update: ToolPreviewUpdate) => void) {
    this.#timer = setTimeout(() => this.#tick(), 1000);
    this.#timer.unref();
  }
  get pendingBytes(): number {
    return this.#pendingBytes;
  }
  get unavailable(): boolean {
    return this.#unavailable;
  }
  #tick(): void {
    if (this.#closed) return;
    const remaining = this.#lastEmission + 1000 - Date.now();
    if (remaining <= 0) this.flush();
    if (!this.#closed) {
      this.#timer = setTimeout(() => this.#tick(), remaining > 0 ? remaining : 1000);
      this.#timer.unref();
    }
  }

  append(text: string): void {
    if (this.#closed || this.#unavailable || !text) return;
    this.#seen = true;
    const size = Buffer.byteLength(text);
    if (this.#pendingBytes + size > MAX_PENDING_BYTES) {
      this.#disable();
      return;
    }
    try {
      this.#terminal ??= new xterm.Terminal({
        cols: 120,
        rows: 24,
        scrollback: 100,
        convertEol: true,
        allowProposedApi: true,
      });
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length; offset += PARSE_CHUNK_BYTES)
        this.#queue.push(bytes.subarray(offset, offset + PARSE_CHUNK_BYTES));
      this.#pendingBytes += size;
      this.#pump();
    } catch {
      this.#disable();
    }
  }
  #pump(): void {
    if (this.#closed || this.#unavailable || this.#parsing) return;
    const chunk = this.#queue.shift(),
      terminal = this.#terminal;
    if (!chunk || !terminal) return;
    this.#parsing = true;
    try {
      terminal.write(chunk, () => {
        if (this.#closed || terminal !== this.#terminal) return;
        this.#parsing = false;
        this.#pendingBytes -= chunk.length;
        this.#dirty = true;
        this.#pump();
      });
    } catch {
      this.#disable();
    }
  }
  #text(): string {
    if (!this.#terminal) return this.#previous?.text ?? "";
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++)
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    while (lines.at(-1) === "") lines.pop();
    return boundedPreviewText(redactToolText(lines.join("\n")));
  }
  flush(now = Date.now()): void {
    if (this.#closed || !this.#seen || now - this.#lastEmission < 1000) return;
    const reset = !this.#previous || now - this.#lastReset >= TOOL_PREVIEW_RESET_MS;
    if (!this.#dirty && !reset) return;
    let text: string;
    try {
      text = this.#text();
    } catch {
      this.#disable();
      text = this.#previous?.text ?? "";
    }
    if (!text && !this.#unavailable && !this.#previous) return;
    this.#dirty = false;
    if (
      !reset &&
      this.#previous?.text === text &&
      Boolean(this.#previous.unavailable) === this.#unavailable
    )
      return;
    const next: ToolPreviewState = {
      revision: (this.#previous?.revision ?? 0) + 1,
      text,
      ...(this.#unavailable ? { unavailable: true as const } : {}),
    };
    const update = previewUpdate(this.#previous, next, reset);
    this.#previous = next;
    this.#lastEmission = now;
    if (update.kind === "reset") this.#lastReset = now;
    try {
      this.emit(update);
    } catch {
      this.close();
    }
  }
  #disable(): void {
    this.#unavailable = true;
    this.#dirty = true;
    this.#queue = [];
    this.#pendingBytes = 0;
    const terminal = this.#terminal;
    this.#terminal = undefined;
    this.#parsing = false;
    try {
      terminal?.dispose();
    } catch {
      /* A display failure never fails the Tool. */
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#disable();
  }
}
