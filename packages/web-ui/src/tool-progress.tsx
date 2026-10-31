import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import type { ToolProgressStore } from "./tool-progress-store.ts";
import { useI18n } from "./i18n.tsx";
import { HistoryDisclosureContext } from "./history-disclosure.tsx";

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
  const observed = useSyncExternalStore(
    subscribe,
    () => store.get(id),
    () => undefined,
  );
  const disclosure = useContext(HistoryDisclosureContext);
  const selectionActive = disclosure?.isSelecting?.() ?? disclosure?.selectionActive ?? false;
  const held = useRef(observed);
  if (!selectionActive) held.current = observed;
  const progress = held.current;
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
