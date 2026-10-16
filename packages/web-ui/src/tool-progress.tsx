import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import type { ToolProgress } from "@pi-cloud/protocol";
import { ToolPreviewBuffer, type ToolPreviewState } from "@pi-cloud/protocol";
import { useI18n } from "./i18n.tsx";

/** Only mounted running Tool cards retain observations; never part of SessionView. */
export class ToolProgressStore {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #values = new Map<string, { operationId: string; buffer: ToolPreviewBuffer }>();
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) this.#listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.#listeners.delete(key);
        this.#values.delete(key);
      }
    };
  }
  get(key: string): ToolPreviewState | undefined {
    return this.#values.get(key)?.buffer.current;
  }
  receive(progress: ToolProgress): void {
    const key = `${progress.turnId}\0${progress.toolCallId}`;
    const listeners = this.#listeners.get(key);
    if (!listeners) return;
    let view = this.#values.get(key);
    if (view && view.operationId !== progress.operationId) return;
    if (!view) {
      view = { operationId: progress.operationId, buffer: new ToolPreviewBuffer() };
      this.#values.set(key, view);
    }
    try {
      if (!view.buffer.accept(progress.update)) return;
    } catch {
      return;
    }
    for (const listener of listeners) listener();
  }
  reset(): void {
    this.#values.clear();
    for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
  }
}
export const ToolProgressContext = createContext<{
  store: ToolProgressStore;
  turnId: string;
} | null>(null);

function ProgressPreview({ store, id }: { store: ToolProgressStore; id: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(id, listener),
    [store, id],
  );
  const progress = useSyncExternalStore(
    subscribe,
    () => store.get(id),
    () => undefined,
  );
  useLayoutEffect(() => {
    // Follow only inside the fixed-height log box, and respect manual scrolling.
    if (output.current && following.current) output.current.scrollTop = output.current.scrollHeight;
  }, [expanded, progress]);
  return (
    <div className="product-tool-progress">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? "▾" : "▸"} {t("turn.liveOutput")}
      </button>
      {expanded ? (
        <pre
          ref={output}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 8;
          }}
          aria-label={t("turn.liveOutput")}
          className="product-tool-progress-tail"
        >
          {progress?.unavailable
            ? [progress.text, t("turn.previewUnavailable")].filter(Boolean).join("\n\n")
            : progress?.text || t("turn.waitingOutput")}
        </pre>
      ) : null}
    </div>
  );
}
export function LiveToolProgress({ toolCallId }: { toolCallId: string }) {
  const context = useContext(ToolProgressContext);
  return context ? (
    <ProgressPreview store={context.store} id={`${context.turnId}\0${toolCallId}`} />
  ) : null;
}
