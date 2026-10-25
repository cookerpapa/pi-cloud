import { HistoryDisclosureContext } from "./history-disclosure.tsx";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  ConversationHistoryQuery,
  PiCloudEvent,
  ConversationSearchResult,
} from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import type { SessionViewState } from "./session-view.ts";
import {
  appendHistoryPage,
  freezeHistoryView,
  historyBeforeQuery,
  historyPage,
  mergeHistoryPages,
  observeHistoryPages,
  type HistoryPage,
} from "./history-window.ts";
import {
  virtualConversationRows,
  type VirtualConversationRow,
} from "./virtual-conversation-rows.ts";
import { useI18n } from "./i18n.tsx";

type Anchor = { key: string; offset: number };
type Target = { turnId: string; entryId: string };
export type TimelineControl = { event(event: PiCloudEvent): void; latest(): void; search(): void };

/** Browsing owns a bounded read window. The live reducer remains independent so
 * a slow historical request cannot overwrite newer execution/output coverage. */
export function ConversationTimeline({
  api,
  live,
  scrollerRef,
  controlRef,
  jump,
  onJumpSettled,
  renderRow,
  inherited,
}: {
  api: PiCloudApi;
  live: SessionViewState;
  scrollerRef: RefObject<HTMLElement | null>;
  controlRef: RefObject<TimelineControl | null>;
  jump: Target | null;
  onJumpSettled(): void;
  renderRow(row: VirtualConversationRow): ReactNode;
  inherited?: ReactNode;
}) {
  const { t } = useI18n();
  const sessionId = live.session?.sessionId;
  const [pages, setPages] = useState<readonly HistoryPage[] | null>(null);
  const pagesOwner = useRef<string | undefined>(sessionId);
  const ownedPages = pagesOwner.current === sessionId ? pages : null;
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<Target | { cursor: string } | null>(null);
  const [newOutput, setNewOutput] = useState(false);
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false),
    [searchText, setSearchText] = useState("");
  const [searchResult, setSearchResult] = useState<ConversationSearchResult | null>(null),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(false);
  const searchAbort = useRef<AbortController | null>(null),
    searchInput = useRef<HTMLInputElement | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const pagesRef = useRef(pages);
  pagesRef.current = ownedPages;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const request = useRef<AbortController | null>(null),
    epoch = useRef(0),
    busy = useRef(false);
  const anchor = useRef<Anchor | null>(null),
    guardUntil = useRef(0),
    initial = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const browsingTurns = useMemo(
    () => (ownedPages ? mergeHistoryPages(ownedPages) : undefined),
    [ownedPages],
  );
  const visibleTurns = browsingTurns ?? live.turns;
  const showInherited =
    Boolean(inherited) && !(ownedPages?.[0]?.history.hasBefore ?? live.history.hasBefore);
  const rows = useMemo(
    () => [...(showInherited ? [null] : []), ...virtualConversationRows(visibleTurns)],
    [visibleTurns, showInherited],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hasOlder = ownedPages?.[0]?.history.hasBefore ?? live.history.hasBefore;
  const loadingZone = hasOlder ? Math.max(160, scrollerRef.current?.clientHeight ?? 600) : 40;
  const stableKeys = useRef<readonly string[]>([]);
  const candidateKeys = rows.map((r) => r?.key ?? "inherited");
  if (
    candidateKeys.length !== stableKeys.current.length ||
    candidateKeys.some((key, index) => key !== stableKeys.current[index])
  )
    stableKeys.current = candidateKeys;
  const keys = stableKeys.current;
  const getItemKey = useCallback((index: number) => keys[index]!, [keys]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey,
    estimateSize: () => 120,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
    anchorTo: "end",
    followOnAppend: ownedPages === null,
    scrollEndThreshold: 80,
    paddingStart: loadingZone,
    paddingEnd: 80,
  });
  // A late image above the reading point must compensate even after a backward
  // gesture. Keep first-measurement correction, but never shift for growth at
  // the bottom of the message the user is currently reading.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0;
    return instance.itemSizeCache.has(item.key) ? item.end <= offset + 1 : item.start < offset;
  };
  const capture = useCallback(() => {
    const container = scrollerRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const first = [...container.querySelectorAll<HTMLElement>("[data-history-row-key]")].find(
      (e) => e.getBoundingClientRect().bottom > top + 2,
    );
    if (first?.dataset.historyRowKey)
      anchor.current = {
        key: first.dataset.historyRowKey,
        offset: first.getBoundingClientRect().top - top,
      };
  }, [scrollerRef]);
  const latest = useCallback(() => {
    request.current?.abort();
    epoch.current++;
    busy.current = false;
    setLoading(false);
    setError(false);
    anchor.current = null;
    guardUntil.current = performance.now() + 500;
    setPages(null);
    setNewOutput(false);
    if (sessionRef.current)
      try {
        sessionStorage.removeItem(`pi-cloud:reading:${sessionRef.current}`);
      } catch {}
    requestAnimationFrame(() => virtualizer.scrollToEnd());
  }, [virtualizer]);
  const load = useCallback(
    async (
      query: ConversationHistoryQuery,
      direction: "before" | "after" | "replace",
      target?: Target | { cursor: string },
      restored?: Anchor,
    ) => {
      const id = sessionRef.current;
      if (!id || (busy.current && direction !== "replace")) return;
      busy.current = true;
      setLoading(true);
      setError(false);
      const abort = new AbortController();
      request.current?.abort();
      request.current = abort;
      const version = ++epoch.current;
      try {
        const value = await api.getConversation(id, query, abort.signal);
        if (abort.signal.aborted || sessionRef.current !== id || version !== epoch.current) return;
        const next = historyPage(value);
        const replacement = [next];
        // Around reads end at the target. Retain one following page as well so
        // a remembered row can sit at its old viewport offset, not be clamped
        // to the bottom of an otherwise empty suffix.
        if (direction === "replace" && target && next.history.hasAfter && next.history.after) {
          const following = historyPage(
            await api.getConversation(id, { after: next.history.after }, abort.signal),
          );
          if (abort.signal.aborted || sessionRef.current !== id || version !== epoch.current)
            return;
          if (following.turns.length) replacement.push(following);
          else replacement[0] = { ...next, history: { ...next.history, hasAfter: false } };
        }
        if (direction !== "replace") capture();
        else anchor.current = restored ?? null;
        pagesOwner.current = id;
        setPages((current) => {
          if (direction === "replace") return replacement;
          const existing = current ?? [freezeHistoryView(liveRef.current)];
          if (!next.turns.length) {
            return existing.map((p, index) =>
              index === (direction === "before" ? 0 : existing.length - 1)
                ? {
                    ...p,
                    history: {
                      ...p.history,
                      [direction === "before" ? "hasBefore" : "hasAfter"]: false,
                    },
                  }
                : p,
            );
          }
          return appendHistoryPage(existing, next, direction);
        });
        if (target) {
          setPendingTarget(target);
          if ("cursor" in target) {
            const matches = next.turns.flatMap((turn) =>
              turn.items.flatMap((item) =>
                item.kind === "tool" && item.historyCursor === target.cursor
                  ? [
                      `${turn.turnId}\0${item.toolCallId}\0activity`,
                      `${turn.turnId}\0${item.toolCallId}\0details`,
                    ]
                  : [],
              ),
            );
            if (matches.length)
              setDisclosures((previous) => ({
                ...previous,
                ...Object.fromEntries(matches.map((key) => [key, true])),
              }));
          }
        }
        guardUntil.current = performance.now() + 200;
      } catch (e) {
        if (!abort.signal.aborted && version === epoch.current) setError(true);
      } finally {
        if (version === epoch.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [api, capture],
  );

  useEffect(() => {
    request.current?.abort();
    epoch.current++;
    busy.current = false;
    setLoading(false);
    setError(false);
    setPages(null);
    setPendingTarget(null);
    setNewOutput(false);
    setDisclosures({});
    initial.current = null;
    anchor.current = null;
    guardUntil.current = performance.now() + 500;
    if (sessionId && !jump) {
      try {
        const saved = JSON.parse(
          sessionStorage.getItem(`pi-cloud:reading:${sessionId}`) ?? "null",
        ) as {
          query?: ConversationHistoryQuery;
          key?: string;
          offset?: number;
          disclosures?: Record<string, boolean>;
        } | null;
        if (saved?.disclosures) setDisclosures(saved.disclosures);
        if (saved?.query)
          void load(
            saved.query,
            "replace",
            saved.query.at
              ? { cursor: saved.query.at }
              : saved.query.turnId && saved.query.entryId
                ? { turnId: saved.query.turnId, entryId: saved.query.entryId }
                : undefined,
            saved.key ? { key: saved.key, offset: saved.offset ?? 0 } : undefined,
          );
      } catch {}
    }
    searchAbort.current?.abort();
    setSearchOpen(false);
    setSearchResult(null);
    setSearching(false);
    return () => {
      request.current?.abort();
      searchAbort.current?.abort();
      clearTimeout(saveTimer.current);
    };
  }, [sessionId]);
  useEffect(() => {
    if (!jump || !sessionId) return;
    void load({ turnId: jump.turnId, entryId: jump.entryId }, "replace", jump);
    onJumpSettled();
  }, [jump, sessionId, load, onJumpSettled]);
  useEffect(() => {
    controlRef.current = {
      latest,
      search() {
        setSearchOpen((value) => !value);
        requestAnimationFrame(() => searchInput.current?.focus());
      },
      event(event) {
        if (pagesRef.current !== null) {
          setNewOutput(true);
          setPages((p) => (p ? observeHistoryPages(p, event) : p));
        }
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [latest, controlRef]);

  const search = async (before?: string) => {
    const id = sessionRef.current,
      needle = searchText.trim();
    if (!id || !needle) return;
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    setSearching(true);
    setSearchError(false);
    let cursor = before;
    try {
      for (;;) {
        const result = await api.searchConversation(id, needle, cursor, abort.signal);
        if (abort.signal.aborted || sessionRef.current !== id) return;
        setSearchResult(result);
        if (result.results.length || !result.nextCursor) return;
        if (cursor === result.nextCursor) throw new Error("Search did not advance");
        cursor = result.nextCursor;
      }
    } catch {
      if (!abort.signal.aborted) setSearchError(true);
    } finally {
      if (searchAbort.current === abort) setSearching(false);
    }
  };

  const measuredKeys = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!sessionId || !rows.length) return;
    const keys = new Set(rows.map((row) => row?.key ?? "inherited"));
    if ([...measuredKeys.current].some((key) => !keys.has(key))) {
      virtualizer.measure();
      for (const node of scrollerRef.current?.querySelectorAll<HTMLElement>(
        "[data-history-row-key][data-index]",
      ) ?? [])
        virtualizer.measureElement(node);
      if (ownedPages === null) virtualizer.scrollToEnd();
    }
    measuredKeys.current = keys;
    const remembered = anchor.current;
    let restored = false;
    if (remembered) {
      anchor.current = null;
      const index = rows.findIndex((r) => r?.key === remembered.key);
      if (index >= 0) {
        restored = true;
        initial.current = sessionId;
        setPendingTarget(null);
        guardUntil.current = performance.now() + 200;
        virtualizer.scrollToIndex(index, { align: "start" });
        requestAnimationFrame(() => {
          const container = scrollerRef.current;
          const element = container?.querySelector<HTMLElement>(
            `[data-history-row-key="${CSS.escape(remembered.key)}"]`,
          );
          if (container && element)
            virtualizer.scrollToOffset(
              container.scrollTop +
                element.getBoundingClientRect().top -
                container.getBoundingClientRect().top -
                remembered.offset,
            );
        });
      }
    }
    if (!restored && pendingTarget) {
      const index = rows.findIndex(
        (r) =>
          r &&
          ("cursor" in pendingTarget
            ? r.cursor === pendingTarget.cursor || r.cursors?.includes(pendingTarget.cursor)
            : r.turn.turnId === pendingTarget.turnId && r.entryId === pendingTarget.entryId),
      );
      const fallback =
        "turnId" in pendingTarget
          ? rows.findIndex((r) => r?.turn.turnId === pendingTarget.turnId)
          : -1;
      if (index >= 0 || fallback >= 0) {
        virtualizer.scrollToIndex(index >= 0 ? index : fallback, { align: "start" });
        setPendingTarget(null);
      }
      initial.current = sessionId;
      guardUntil.current = performance.now() + 250;
    } else if (!restored && initial.current !== sessionId) {
      initial.current = sessionId;
      if (ownedPages === null && !jump) virtualizer.scrollToEnd();
    }
  }, [rows, pendingTarget, sessionId, virtualizer, ownedPages, jump, scrollerRef]);

  const earlier = () => {
    const first = pagesRef.current?.[0] ?? freezeHistoryView(liveRef.current);
    const query = historyBeforeQuery(first);
    if (query) void load(query, "before");
  };
  const newer = () => {
    const last = pagesRef.current?.at(-1);
    const query =
      last?.afterQuery ?? (last?.history.after ? { after: last.history.after } : undefined);
    if (query) void load(query, "after");
  };
  const scrolling = () => {
    const container = scrollerRef.current;
    if (!container || performance.now() < guardUntil.current) return;
    const end = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    if (!end && pagesRef.current === null) {
      capture();
      pagesOwner.current = sessionRef.current;
      setPages([freezeHistoryView(liveRef.current)]);
    }
    if (pagesRef.current === null) {
      return;
    }

    if (!busy.current && !error) {
      if (container.scrollTop < loadingZone + 250 && pagesRef.current[0]?.history.hasBefore)
        earlier();
      else if (
        container.scrollHeight - container.scrollTop - container.clientHeight < 250 &&
        pagesRef.current.at(-1)?.history.hasAfter
      )
        newer();
    }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const id = sessionRef.current;
      if (!id || pagesRef.current === null) return;
      capture();
      const saved = anchor.current;
      anchor.current = null;
      const row = saved ? rowsRef.current.find((r) => r?.key === saved.key) : undefined;
      const query = row?.cursor
        ? { at: row.cursor }
        : row?.entryId
          ? { turnId: row.turn.turnId, entryId: row.entryId }
          : undefined;
      if (query)
        try {
          sessionStorage.setItem(
            `pi-cloud:reading:${id}`,
            JSON.stringify({ query, key: saved!.key, offset: saved!.offset, disclosures }),
          );
        } catch {}
    }, 300);
  };
  const before = ownedPages?.[0]?.history.hasBefore ?? live.history.hasBefore;
  const after = ownedPages?.at(-1)?.history.hasAfter ?? false;
  const disclosureState = useMemo(
    () => ({
      values: disclosures,
      set(keys: readonly string[], value: boolean) {
        setDisclosures((previous) => {
          const next = { ...previous };
          for (const key of keys) next[key] = value;
          return next;
        });
      },
    }),
    [disclosures],
  );
  useEffect(() => {
    if (busy.current) return;
    const allowed = new Set(
      visibleTurns.flatMap((turn) =>
        turn.items.flatMap((item) =>
          item.kind === "tool" ? [`${turn.turnId}\0${item.toolCallId}`] : [],
        ),
      ),
    );
    setDisclosures((previous) => {
      const entries = Object.entries(previous).filter(([key]) =>
        allowed.has(key.split("\0").slice(0, 2).join("\0")),
      );
      return entries.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(entries);
    });
  }, [visibleTurns, loading]);
  return (
    <HistoryDisclosureContext.Provider value={disclosureState}>
      {searchOpen ? (
        <aside className="product-history-search" aria-label={t("chat.searchHistory")}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <input
              ref={searchInput}
              value={searchText}
              aria-label={t("chat.searchHistory")}
              onChange={(event) => {
                searchAbort.current?.abort();
                setSearching(false);
                setSearchText(event.target.value);
                setSearchResult(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  searchAbort.current?.abort();
                  setSearching(false);
                  setSearchOpen(false);
                }
              }}
            />
            <button type="submit" disabled={searching || !searchText.trim()}>
              {t("chat.searchHistory")}
            </button>
            <button
              type="button"
              onClick={() => {
                searchAbort.current?.abort();
                setSearching(false);
                setSearchOpen(false);
              }}
            >
              ×
            </button>
          </form>
          {searching ? <span role="status">{t("chat.searchingHistory")}</span> : null}
          {searchError ? <span role="alert">{t("chat.historyFailed")}</span> : null}
          {searchResult?.results.map((result) => (
            <button
              type="button"
              key={result.cursor}
              className="product-history-hit"
              onClick={() => {
                setSearchOpen(false);
                void load({ at: result.cursor }, "replace", { cursor: result.cursor });
              }}
            >
              {result.snippet}
            </button>
          ))}
          {searchResult?.nextCursor && !searching ? (
            <button type="button" onClick={() => void search(searchResult.nextCursor!)}>
              {t("chat.searchMore")}
            </button>
          ) : null}
        </aside>
      ) : null}
      <section
        className="product-chat-scroll"
        ref={scrollerRef as RefObject<HTMLElement>}
        onScroll={scrolling}
        onWheel={(event) => {
          if (
            event.deltaY < 0 &&
            !busy.current &&
            !error &&
            (scrollerRef.current?.scrollTop ?? 0) < loadingZone + 250 &&
            hasOlder
          )
            earlier();
        }}
        data-history-pages={ownedPages?.length ?? 0}
        data-history-rows={rows.length}
        aria-label={t("chat.historyLabel")}
      >
        <div className="product-transcript product-virtual-transcript">
          <div className="product-history-controls">
            {before ? (
              <button type="button" disabled={loading} onClick={earlier}>
                {loading ? t("chat.loadingHistory") : t("chat.loadEarlier")}
              </button>
            ) : null}
            {error ? <span role="alert">{t("chat.historyFailed")}</span> : null}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  data-history-row-key={row?.key ?? "inherited"}
                  {...(row ? { "data-conversation-turn-id": row.turn.turnId } : {})}
                  {...(row?.entryId ? { "data-conversation-entry-id": row.entryId } : {})}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {row ? renderRow(row) : inherited}
                </div>
              );
            })}
          </div>
          {after ? (
            <button
              className="product-history-newer"
              type="button"
              disabled={loading}
              onClick={newer}
            >
              {loading ? t("chat.loadingHistory") : t("chat.loadNewer")}
            </button>
          ) : null}
        </div>
      </section>
      {ownedPages !== null ? (
        <button className="product-return-to-latest" type="button" onClick={latest}>
          {newOutput ? t("chat.newOutput") : t("chat.latest")}
        </button>
      ) : null}
    </HistoryDisclosureContext.Provider>
  );
}
