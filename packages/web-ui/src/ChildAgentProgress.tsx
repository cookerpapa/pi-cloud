import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  RUN_OBSERVATION_STALE_MS,
  type DelegatedSessionSummaryResource,
  type RunObservation,
} from "@pi-cloud/protocol";
import type { RunObservationStore } from "./run-observation-store.ts";
import { useI18n, type Translate } from "./i18n.tsx";

type ChildObservation = Extract<RunObservation, { type: "run.child_activity" }>;
export const ChildAgentProgressContext = createContext<{
  turnId: string;
  children: readonly DelegatedSessionSummaryResource[];
  store?: RunObservationStore;
  onNavigate?: (child: DelegatedSessionSummaryResource) => void;
} | null>(null);

export function childProgressLabel(
  child: DelegatedSessionSummaryResource,
  observation: ChildObservation | undefined,
  now: number,
  t: Translate,
): string {
  const terminal = (state: string) => {
    if (state === "completed") return t("turn.completed");
    if (state === "failed") return t("turn.failed");
    if (state === "cancelled") return t("child.cancelled");
    if (state === "unknown") return t("turn.unknown");
    return undefined;
  };
  const settled = terminal(child.state);
  if (settled) return settled;
  if (
    observation &&
    observation.childSessionId === child.sessionId &&
    observation.childTurnId === child.turnId &&
    observation.parentToolCallId === child.parentToolCallId
  ) {
    const outcome = terminal(observation.state);
    if (outcome) return outcome;
    if (now - observation.observedAt <= RUN_OBSERVATION_STALE_MS)
      return t(`run.phase.${observation.phase}`);
  }
  return child.state === "preparing" ? t("run.phase.preparing") : t("child.updating");
}

/** A compact view of existing child relationships, never a second transcript. */
export function ChildAgentProgress({ toolCallId }: { toolCallId: string }) {
  const context = useContext(ChildAgentProgressContext);
  const children = context?.children.filter((child) => child.parentToolCallId === toolCallId) ?? [];
  return context && children.length ? (
    <ChildAgentProgressRows context={context} children={children} />
  ) : null;
}

function ChildAgentProgressRows({
  context,
  children,
}: {
  context: NonNullable<React.ContextType<typeof ChildAgentProgressContext>>;
  children: readonly DelegatedSessionSummaryResource[];
}) {
  const { t } = useI18n();
  const store = context?.store;
  const turnId = context?.turnId ?? "";
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(turnId, listener) ?? (() => {}),
    [store, turnId],
  );
  const snapshot = useCallback(() => store?.get(turnId), [store, turnId]);
  const observations = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [now, setNow] = useState(Date.now);
  const active = children.some((child) => child.state === "running" || child.state === "preparing");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div className="product-child-progress-list">
      {children.map((child) => (
        <div className="product-child-progress" key={child.executionId}>
          <span className="product-child-task" title={child.title}>
            {child.title}
          </span>
          <span className="product-child-phase">
            {childProgressLabel(child, observations?.children?.get(child.sessionId), now, t)}
          </span>
          {context?.onNavigate ? (
            <button type="button" onClick={() => context.onNavigate?.(child)}>
              {t("child.view")}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
