import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationUsageResource, ConversationCompactResource } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { compactionPending } from "./composer-commands.ts";

/** Reads are event-driven. Only an outstanding command has a slow reconciliation
 * fallback; a hidden usage panel never polls and text deltas trigger no reads. */
export function useConversationCommands(api: PiCloudApi, sessionId: string | undefined) {
  const usageSession = useRef(sessionId);
  const current = useRef(sessionId);
  current.current = sessionId;
  const [usageOpen, setUsageOpen] = useState(false),
    openRef = useRef(false);
  openRef.current = usageOpen && usageSession.current === sessionId;
  const [usage, setUsage] = useState<ConversationUsageResource | null>(null);
  const [usageError, setUsageError] = useState(false),
    [usageLoading, setUsageLoading] = useState(false);
  const [compact, setCompact] = useState<ConversationCompactResource | null>(null),
    compactRef = useRef(compact);
  compactRef.current = compact;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshFlags = useRef({ compact: false, usage: false });
  const revision = useRef(0),
    usageRequest = useRef<AbortController | null>(null),
    compactRequest = useRef<AbortController | null>(null);
  const refreshUsage = useCallback(async () => {
    if (!sessionId) return false;
    usageRequest.current?.abort();
    const abort = new AbortController();
    usageRequest.current = abort;
    setUsageLoading(true);
    setUsageError(false);
    try {
      const value = await api.getConversationUsage(sessionId, abort.signal);
      if (abort.signal.aborted || current.current !== sessionId) return false;
      setUsage((old) =>
        old && old.sessionId === sessionId && old.nativeSequence > value.nativeSequence
          ? old
          : value,
      );
      return true;
    } catch {
      if (!abort.signal.aborted && current.current === sessionId) setUsageError(true);
      return false;
    } finally {
      if (!abort.signal.aborted && current.current === sessionId) setUsageLoading(false);
    }
  }, [api, sessionId]);
  const refreshCompact = useCallback(async () => {
    if (!sessionId) return;
    compactRequest.current?.abort();
    const abort = new AbortController();
    compactRequest.current = abort;
    const version = revision.current;
    try {
      const value = await api.getCompaction(sessionId, undefined, abort.signal);
      if (abort.signal.aborted || current.current !== sessionId || version !== revision.current)
        return;
      setCompact((old) => {
        if (
          old &&
          compactionPending(old.state) &&
          (!value || value.nativeSequence < old.nativeSequence)
        )
          return old;
        return value;
      });
    } catch {
      /* SSE reconnect and the active-command reconciliation retry this read. */
    }
  }, [api, sessionId]);
  useEffect(() => {
    revision.current++;
    setUsageOpen(false);
    setUsage(null);
    setUsageError(false);
    setUsageLoading(false);
    setCompact(null);
    void refreshCompact();
    return () => {
      usageRequest.current?.abort();
      compactRequest.current?.abort();
      clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
      refreshFlags.current = { compact: false, usage: false };
    };
  }, [refreshCompact]);
  useEffect(() => {
    if (!compact || !compactionPending(compact.state)) return;
    const timer = setInterval(() => void refreshCompact(), 10000);
    return () => clearInterval(timer);
  }, [compact?.commandId, compact?.state, refreshCompact]);
  const notify = useCallback(
    (type: string) => {
      if (
        ![
          "snapshot",
          "model.sampling.started",
          "model.sampling.completed",
          "context.compaction.started",
          "context.compaction.completed",
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
        ].includes(type)
      )
        return;
      if (
        type === "snapshot" ||
        type.startsWith("context.compaction") ||
        (compactRef.current && compactionPending(compactRef.current.state))
      )
        refreshFlags.current.compact = true;
      if (
        openRef.current &&
        (type !== "model.sampling.started" || compactRef.current?.state === "awaiting_placement")
      )
        refreshFlags.current.usage = true;
      if (refreshTimer.current === undefined)
        refreshTimer.current = setTimeout(() => {
          const flags = refreshFlags.current;
          refreshFlags.current = { compact: false, usage: false };
          refreshTimer.current = undefined;
          if (flags.compact) void refreshCompact();
          if (flags.usage && openRef.current) void refreshUsage();
        }, 100);
    },
    [refreshCompact, refreshUsage],
  );
  return {
    usageOpen: usageOpen && usageSession.current === sessionId,
    usage: usage?.sessionId === sessionId ? usage : null,
    usageError,
    usageLoading,
    compact: compact?.sessionId === sessionId ? compact : null,
    notify,
    refreshUsage,
    closeUsage() {
      setUsageOpen(false);
      usageRequest.current?.abort();
    },
    async openUsage() {
      usageSession.current = sessionId;
      setUsageOpen(true);
      return refreshUsage();
    },
    acceptedCompact(value: ConversationCompactResource) {
      if (current.current !== value.sessionId) return;
      revision.current++;
      compactRequest.current?.abort();
      setCompact(value);
    },
  };
}
