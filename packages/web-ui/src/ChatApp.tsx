import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  ConversationTreeResource,
  ConversationTreeView,
  ConversationSummaryResource,
  DelegatedSessionSummaryResource,
  DevelopmentEnvironmentListResource,
  DevelopmentEnvironmentProfileKey,
  DevelopmentEnvironmentResource,
  SshAccessTicketResource,
  TenantIdentityResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { DEFAULT_EXCLUSIVE_WORKING_DIRECTORY } from "@pi-cloud/protocol";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "./api.ts";
import { AdminPage } from "./AdminPage.tsx";
import { AuthScreen } from "./AuthScreen.tsx";
import { ConversationTreeNavigator } from "./ConversationTreeNavigator.tsx";
import { ConversationTurn, Markdown } from "./ConversationTurn.tsx";
import { isConversationTailVisible } from "./conversation-scroll.ts";
import { activeTurn, createInitialSessionView, sessionViewReducer } from "./session-view.ts";
import { streamSessionEvents } from "./sse.ts";
import { errorMessage } from "./ui-errors.ts";
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";
import { WorkspaceDirectoryPicker } from "./WorkspaceDirectoryPicker.tsx";
import { ResourceManagementPage } from "./ResourceManagementPage.tsx";
import { useResizablePanel } from "./use-resizable-panel.ts";
import { LanguageSelect, useI18n, type Translate, type UiLanguage } from "./i18n.tsx";

type AuthPhase = "checking" | "anonymous" | "authenticated";

function conversationTitle(prompt: string, fallback: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact || fallback;
}

function relativeTime(value: string, language: UiLanguage, t: Translate): string {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return t("chat.relative.now");
  if (seconds < 3_600) return t("chat.relative.minutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("chat.relative.hours", { count: Math.floor(seconds / 3_600) });
  if (seconds < 604_800) return t("chat.relative.days", { count: Math.floor(seconds / 86_400) });
  return new Date(value).toLocaleDateString(language);
}

function delegatedContextLabel(
  mode: DelegatedSessionSummaryResource["contextMode"],
  t: Translate,
): string {
  return mode === "fork" ? t("chat.context.inherited") : t("chat.context.fresh");
}

function delegatedWorkspaceLabel(
  mode: DelegatedSessionSummaryResource["workspaceMode"],
  t: Translate,
): string {
  if (mode === "shared_serialized") return t("chat.workspace.shared");
  if (mode === "isolated") return t("chat.workspace.isolated");
  return t("chat.workspace.none");
}

function delegatedStateLabel(
  state: DelegatedSessionSummaryResource["state"],
  t: Translate,
): string {
  if (state === "queued") return t("chat.state.queued");
  if (state === "running") return t("chat.state.running");
  if (state === "completed") return t("chat.state.completed");
  if (state === "failed") return t("chat.state.failed");
  if (state === "cancelled") return t("chat.state.cancelled");
  return state;
}

function developmentStateLabel(
  state: DevelopmentEnvironmentResource["state"],
  t: Translate,
): string {
  return t(`resource.state.${state}` as const);
}

export default function ChatApp() {
  const { language, t } = useI18n();
  const api = useMemo(() => new PiCloudApi(), []);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [state, setState] = useState(createInitialSessionView);
  const [conversations, setConversations] = useState<readonly ConversationSummaryResource[]>([]);
  const [delegatedSessions, setDelegatedSessions] = useState<
    readonly DelegatedSessionSummaryResource[]
  >([]);
  const [selectedDelegatedSession, setSelectedDelegatedSession] =
    useState<DelegatedSessionSummaryResource | null>(null);
  const [conversationTree, setConversationTree] = useState<ConversationTreeResource | null>(null);
  const [treeView, setTreeView] = useState<ConversationTreeView>("focus");
  const [treeLoading, setTreeLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummaryResource[]>([]);
  const [developmentEnvironments, setDevelopmentEnvironments] = useState<
    readonly DevelopmentEnvironmentResource[]
  >([]);
  const [developmentProfiles, setDevelopmentProfiles] = useState<
    DevelopmentEnvironmentListResource["profiles"]
  >([]);
  const [conversationLoading, setConversationLoading] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<
    | "creating"
    | "submitting"
    | "cancelling"
    | "steering"
    | "forking"
    | "pruning"
    | "deleting-conversation"
    | "rebinding-workspace"
    | "managing-environment"
    | null
  >(null);
  const [steerNotice, setSteerNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [resourcePageOpen, setResourcePageOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [workspaceRebindOpen, setWorkspaceRebindOpen] = useState(false);
  const [rebindWorkspaceChoice, setRebindWorkspaceChoice] = useState<"existing" | "new">(
    "existing",
  );
  const [rebindWorkspaceName, setRebindWorkspaceName] = useState("");
  const [sshTicket, setSshTicket] = useState<SshAccessTicketResource | null>(null);
  const [followingConversationTail, setFollowingConversationTail] = useState(true);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState<"existing" | "new">("new");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [executionMode, setExecutionMode] = useState<"elastic" | "exclusive" | null>(null);
  const [selectedDevelopmentEnvironmentId, setSelectedDevelopmentEnvironmentId] = useState("");
  const [developmentProfileKey, setDevelopmentProfileKey] =
    useState<DevelopmentEnvironmentProfileKey>("standard");
  const [workingDirectory, setWorkingDirectory] = useState("/workspace");
  const [pendingInitialPrompt, setPendingInitialPrompt] = useState<string | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [pendingTreeJump, setPendingTreeJump] = useState<{
    turnId: string;
    entryId: string;
  } | null>(null);
  const [forkTarget, setForkTarget] = useState<{
    sourceSessionId: string;
    turnId: string;
    entryId: string;
  } | null>(null);
  const [forkTitle, setForkTitle] = useState("");
  const lastSequenceRef = useRef(0);
  const chatScrollerRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const followingConversationTailRef = useRef(true);
  const currentTurn = activeTurn(state);
  const currentDevelopmentEnvironment = developmentEnvironments.find(
    (environment) =>
      state.session?.sandboxRetention === "persistent" &&
      (state.session.developmentEnvironmentId === undefined
        ? environment.workspaceId === state.session.workspaceId
        : environment.environmentId === state.session.developmentEnvironmentId) &&
      ["requested", "provisioning", "running", "paused", "releasing", "failed", "unknown"].includes(
        environment.state,
      ),
  );
  const selectableDevelopmentEnvironments = developmentEnvironments.filter((environment) =>
    ["running", "paused"].includes(environment.state),
  );
  const elasticWorkspaces = workspaces.filter(
    (workspace) =>
      !developmentEnvironments.some(
        (environment) => environment.workspaceId === workspace.workspaceId,
      ),
  );
  const conversationPanel = useResizablePanel({
    storageKey: "pi-cloud:conversation-list",
    initialWidth: 260,
    minimumWidth: 210,
    maximumWidth: 420,
  });
  const canMutate = identity?.role !== "viewer";
  const canQueue =
    selectedDelegatedSession === null &&
    state.session?.workspaceState !== "missing" &&
    (state.session === null ||
      state.sessionState === "cold" ||
      state.sessionState === "idle" ||
      state.sessionState === "running" ||
      state.sessionState === "waiting_approval" ||
      state.sessionState === "cancelling");
  const conversationChildren = useMemo(() => {
    const children = new Map<string, ConversationSummaryResource[]>();
    for (const conversation of conversations) {
      if (conversation.parentSessionId === undefined) continue;
      const siblings = children.get(conversation.parentSessionId) ?? [];
      siblings.push(conversation);
      children.set(conversation.parentSessionId, siblings);
    }
    return children;
  }, [conversations]);
  const rootConversations = useMemo(() => {
    const known = new Set(conversations.map((conversation) => conversation.sessionId));
    return conversations.filter(
      (conversation) =>
        conversation.parentSessionId === undefined || !known.has(conversation.parentSessionId),
    );
  }, [conversations]);
  const delegatesByParent = useMemo(() => {
    const children = new Map<string, DelegatedSessionSummaryResource[]>();
    for (const delegated of delegatedSessions) {
      const siblings = children.get(delegated.parentSessionId) ?? [];
      siblings.push(delegated);
      children.set(delegated.parentSessionId, siblings);
    }
    return children;
  }, [delegatedSessions]);
  const forkTargets = useMemo(() => {
    const targets = new Map<string, { sourceSessionId: string; turnId: string; entryId: string }>();
    for (const branch of conversationTree?.branches ?? []) {
      for (const entry of branch.entries) {
        if (!entry.finalAssistant) continue;
        targets.set(entry.turnId, {
          sourceSessionId: branch.sessionId,
          turnId: entry.turnId,
          entryId: entry.entryId,
        });
      }
    }
    return targets;
  }, [conversationTree]);

  const update = useCallback((action: Parameters<typeof sessionViewReducer>[1]) => {
    setState((current) => sessionViewReducer(current, action));
  }, []);

  const focusComposer = useCallback((): void => {
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (composer === null || composer.disabled) return;
      composer.focus({ preventScroll: true });
      composer.setSelectionRange(composer.value.length, composer.value.length);
    });
  }, []);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer === null) return;
    composer.style.height = "auto";
    composer.style.height = `${String(Math.min(composer.scrollHeight, 180))}px`;
  }, [prompt]);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const listed = await api.listConversations();
    setConversations(listed.conversations);
    setDelegatedSessions(listed.delegatedSessions);
  }, [api]);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    const listed = await api.listWorkspaces();
    setWorkspaces(listed.workspaces);
    setSelectedWorkspaceId((current) =>
      listed.workspaces.some((workspace) => workspace.workspaceId === current)
        ? current
        : (listed.workspaces[0]?.workspaceId ?? ""),
    );
  }, [api]);

  const refreshDevelopmentEnvironments = useCallback(async (): Promise<void> => {
    const listed = await api.listDevelopmentEnvironments();
    setDevelopmentEnvironments(listed.environments);
    setDevelopmentProfiles(listed.profiles);
    setSelectedDevelopmentEnvironmentId((current) =>
      listed.environments.some(
        (environment) =>
          environment.environmentId === current &&
          ["running", "paused"].includes(environment.state),
      )
        ? current
        : (listed.environments.find((environment) =>
            ["running", "paused"].includes(environment.state),
          )?.environmentId ?? ""),
    );
  }, [api]);

  const refreshConversationTree = useCallback(
    async (sessionId: string, view: ConversationTreeView): Promise<void> => {
      setTreeLoading(true);
      try {
        setConversationTree(await api.getConversationTree(sessionId, view));
      } finally {
        setTreeLoading(false);
      }
    },
    [api],
  );

  const loadConversation = useCallback(
    async (sessionId: string) => {
      const conversation = await api.getConversation(sessionId);
      const liveSnapshot = await api.getLiveTurnSnapshot(sessionId).catch(() => undefined);
      const replayAfterSequence =
        liveSnapshot?.turn === null || liveSnapshot === undefined
          ? conversation.replayAfterSequence
          : liveSnapshot.replayAfterSequence;
      return { conversation, liveSnapshot, replayAfterSequence };
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    void api.getIdentity().then(
      (resolved) => {
        if (cancelled) return;
        setIdentity(resolved);
        setAuthPhase("authenticated");
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof PiCloudApiError && error.status === 401) {
          setIdentity(null);
          setAuthPhase("anonymous");
          return;
        }
        setIdentity(null);
        setAuthPhase("anonymous");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    let cancelled = false;
    void api.listConversations().then(
      (listed) => {
        if (!cancelled) {
          setConversations(listed.conversations);
          setDelegatedSessions(listed.delegatedSessions);
        }
      },
      (error: unknown) => {
        if (!cancelled) update({ type: "api.error", message: errorMessage(error, t) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, identity?.platformAdministrator, identity?.tenantId, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshWorkspaces().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error, t) });
    });
  }, [authPhase, identity?.platformAdministrator, identity?.tenantId, refreshWorkspaces, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshDevelopmentEnvironments().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error, t) });
    });
  }, [
    authPhase,
    identity?.platformAdministrator,
    identity?.tenantId,
    refreshDevelopmentEnvironments,
    update,
  ]);

  useEffect(() => {
    if (
      !developmentEnvironments.some((environment) =>
        ["requested", "provisioning", "releasing", "unknown"].includes(environment.state),
      )
    ) {
      return;
    }
    const timer = setInterval(
      () => void refreshDevelopmentEnvironments().catch(() => undefined),
      2_000,
    );
    return () => clearInterval(timer);
  }, [developmentEnvironments, refreshDevelopmentEnvironments]);

  useEffect(() => {
    const sessionId = state.session?.sessionId;
    if (authPhase !== "authenticated" || sessionId === undefined) {
      setConversationTree(null);
      return;
    }
    let cancelled = false;
    setTreeLoading(true);
    void api
      .getConversationTree(sessionId, treeView)
      .then(
        (tree) => {
          if (!cancelled) setConversationTree(tree);
        },
        (error: unknown) => {
          if (!cancelled) update({ type: "api.error", message: errorMessage(error, t) });
        },
      )
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, state.session?.sessionId, treeView, update]);

  useEffect(() => {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined || authPhase !== "authenticated") return;
    const controller = new AbortController();
    void streamSessionEvents({
      sessionId,
      afterSequence: lastSequenceRef.current,
      signal: controller.signal,
      onEvent(event) {
        lastSequenceRef.current = event.seq;
        update({ type: "stream.event", event });
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          setInspectorRefreshSignal((value) => value + 1);
          void refreshConversations().catch(() => undefined);
          void refreshConversationTree(sessionId, treeView).catch(() => undefined);
        }
      },
      onStatus(status) {
        update({ type: "stream.status", status });
      },
      async onCursorExpired() {
        const loaded = await loadConversation(sessionId);
        lastSequenceRef.current = loaded.replayAfterSequence;
        update({
          type: "conversation.loaded",
          conversation: loaded.conversation,
          ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
        });
        return loaded.replayAfterSequence;
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        update({ type: "api.error", message: t("chat.streamDisconnected") });
      }
    });
    return () => controller.abort();
  }, [
    api,
    authPhase,
    loadConversation,
    reconnectGeneration,
    refreshConversations,
    refreshConversationTree,
    state.session?.sessionId,
    treeView,
    t,
    update,
  ]);

  // A Run can fail before the trusted Runner publishes its first session
  // event (for example during Sandbox provisioning). The durable Run record is
  // therefore the terminal-state fallback for the streaming transcript.
  useEffect(() => {
    const runId = currentTurn?.runId;
    if (runId === null || runId === undefined || authPhase !== "authenticated") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const run = await api.getRun(runId);
        if (cancelled) return;
        update({ type: "run.reconciled", run });
        if (
          run.state === "completed" ||
          run.state === "failed" ||
          run.state === "cancelled" ||
          run.state === "timed_out" ||
          run.state === "superseded"
        ) {
          setInspectorRefreshSignal((value) => value + 1);
          if (state.session !== null) {
            const detail = await api.getConversation(state.session.sessionId).catch(() => null);
            if (!cancelled && detail !== null) {
              update({
                type: "project.environment.refreshed",
                environment: detail.project.environment,
              });
            }
          }
          await refreshConversations().catch(() => undefined);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      timer = setTimeout(() => void poll(), 1_000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, authPhase, currentTurn?.runId, refreshConversations, state.session, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || currentTurn === undefined) return;
    const refresh = (): void => {
      void refreshConversations().catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 1_500);
    return () => clearInterval(timer);
  }, [authPhase, currentTurn?.runId, refreshConversations]);

  const followConversationTail = useCallback((follow: boolean): void => {
    followingConversationTailRef.current = follow;
    setFollowingConversationTail(follow);
  }, []);

  const followProgressiveText = useCallback((): void => {
    if (!followingConversationTailRef.current) return;
    const scroller = chatScrollerRef.current;
    if (scroller !== null) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
  }, []);

  useEffect(() => {
    followConversationTail(true);
  }, [followConversationTail, state.session?.sessionId]);

  useEffect(() => {
    if (!followingConversationTailRef.current) return;
    const frame = requestAnimationFrame(() => {
      const scroller = chatScrollerRef.current;
      if (scroller === null) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.lastSequence, state.turns.length]);

  useEffect(() => {
    if (pendingTreeJump === null) return;
    const target = chatScrollerRef.current?.querySelector<HTMLElement>(
      `[data-conversation-entry-id="${pendingTreeJump.entryId}"], [data-conversation-turn-id="${pendingTreeJump.turnId}"]`,
    );
    if (target === undefined || target === null) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingTreeJump(null);
  }, [pendingTreeJump, state.session?.sessionId, state.turns.length]);

  function resetConversation(): void {
    lastSequenceRef.current = 0;
    setState(createInitialSessionView());
    setPrompt("");
    setInspectorOpen(false);
    setSidebarOpen(false);
    setConversationTree(null);
    setSelectedDelegatedSession(null);
    setPendingTreeJump(null);
    followConversationTail(true);
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      /* The local session is cleared even if logout races expiry. */
    }
    resetConversation();
    setConversations([]);
    setDelegatedSessions([]);
    setWorkspaces([]);
    setIdentity(null);
    setAuthPhase("anonymous");
  }

  async function openConversationSession(
    sessionId: string,
    jumpTarget?: { turnId: string; entryId: string },
    allowDuringOperation = false,
    delegatedSession: DelegatedSessionSummaryResource | null = null,
  ): Promise<void> {
    if (conversationLoading !== null || (!allowDuringOperation && operation !== null)) return;
    setConversationLoading(sessionId);
    update({ type: "api.error.cleared" });
    try {
      const loaded = await loadConversation(sessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      if (loaded.conversation.session.workspaceState === "missing") {
        setSelectedWorkspaceId(elasticWorkspaces[0]?.workspaceId ?? "");
        setRebindWorkspaceChoice(elasticWorkspaces.length === 0 ? "new" : "existing");
        setRebindWorkspaceName("");
        setWorkspaceRebindOpen(true);
      }
      setSelectedDelegatedSession(delegatedSession);
      if (jumpTarget !== undefined) setPendingTreeJump(jumpTarget);
      setSidebarOpen(false);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setConversationLoading(null);
    }
  }

  async function openConversation(conversation: ConversationSummaryResource): Promise<void> {
    return openConversationSession(conversation.sessionId, undefined, false, null);
  }

  async function openDelegatedSession(
    delegatedSession: DelegatedSessionSummaryResource,
  ): Promise<void> {
    return openConversationSession(delegatedSession.sessionId, undefined, false, delegatedSession);
  }

  async function createConversationFork(): Promise<void> {
    if (forkTarget === null || operation !== null) return;
    setOperation("forking");
    update({ type: "api.error.cleared" });
    try {
      const title = forkTitle.trim();
      const forked = await api.forkConversation(
        forkTarget.sourceSessionId,
        forkTarget.turnId,
        forkTarget.entryId,
        title.length === 0 ? undefined : title,
        newIdempotencyKey("fork"),
      );
      setTreeView("focus");
      setForkTarget(null);
      setForkTitle("");
      await Promise.all([
        openConversationSession(
          forked.session.sessionId,
          { turnId: forkTarget.turnId, entryId: forkTarget.entryId },
          true,
        ),
        refreshConversations(),
      ]);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function pruneConversationTail(target: {
    sourceSessionId: string;
    turnId: string;
    entryId: string;
  }): Promise<void> {
    if (
      operation !== null ||
      state.session?.sessionId !== target.sourceSessionId ||
      !window.confirm(t("chat.pruneConfirm"))
    ) {
      return;
    }
    setOperation("pruning");
    update({ type: "api.error.cleared" });
    try {
      await api.pruneConversation(
        target.sourceSessionId,
        target.turnId,
        target.entryId,
        newIdempotencyKey("prune"),
      );
      const loaded = await loadConversation(target.sourceSessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      await Promise.all([
        refreshConversations(),
        refreshConversationTree(target.sourceSessionId, treeView),
        refreshWorkspaces(),
      ]);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  function beginNewConversation(initialPrompt: string | null = null): void {
    resetConversation();
    setPendingInitialPrompt(initialPrompt);
    setNewConversationTitle(
      initialPrompt === null ? "" : conversationTitle(initialPrompt, t("chat.newConversation")),
    );
    setWorkspaceChoice(elasticWorkspaces.length === 0 ? "new" : "existing");
    setSelectedWorkspaceId(elasticWorkspaces[0]?.workspaceId ?? "");
    setNewWorkspaceName("");
    setExecutionMode(null);
    setSelectedDevelopmentEnvironmentId(selectableDevelopmentEnvironments[0]?.environmentId ?? "");
    setDevelopmentProfileKey("standard");
    setWorkingDirectory("/workspace");
    setWorkspacePanelOpen(true);
  }

  async function createConversation(): Promise<void> {
    const title = newConversationTitle.trim();
    if (title.length === 0 || operation !== null) return;
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      let projectId: string;
      let workspaceId: string;
      if (executionMode === null) return;
      const freshDevelopmentEnvironments =
        executionMode === "exclusive"
          ? (await api.listDevelopmentEnvironments()).environments
          : developmentEnvironments;
      if (executionMode === "exclusive") {
        setDevelopmentEnvironments(freshDevelopmentEnvironments);
      }
      const existingEnvironment =
        executionMode === "exclusive"
          ? freshDevelopmentEnvironments.find(
              (environment) =>
                environment.environmentId === selectedDevelopmentEnvironmentId &&
                ["running", "paused"].includes(environment.state),
            )
          : undefined;
      if (executionMode === "exclusive" && existingEnvironment === undefined) {
        update({ type: "api.error", message: t("chat.selectExclusiveError") });
        return;
      }
      if (existingEnvironment?.state === "paused") {
        await api.developmentEnvironmentAction(
          existingEnvironment.environmentId,
          "resume",
          newIdempotencyKey("environment"),
        );
      }
      if (existingEnvironment !== undefined) {
        projectId = existingEnvironment.projectId;
        workspaceId = existingEnvironment.workspaceId;
      } else if (workspaceChoice === "new") {
        const name = newWorkspaceName.trim();
        if (name.length === 0) return;
        const created = await api.createProject(name);
        projectId = created.projectId;
        workspaceId = created.workspaceId;
      } else {
        const selected = elasticWorkspaces.find(
          (workspace) => workspace.workspaceId === selectedWorkspaceId,
        );
        if (selected === undefined) {
          update({ type: "api.error", message: t("chat.selectWorkspaceError") });
          return;
        }
        projectId = selected.projectId;
        workspaceId = selected.workspaceId;
      }
      const sandboxProfileKey = existingEnvironment?.profileKey ?? developmentProfileKey;
      const session = await api.createSession(
        projectId,
        workspaceId,
        title,
        executionMode === "exclusive" ? "persistent" : "ephemeral",
        sandboxProfileKey,
        executionMode === "exclusive" ? workingDirectory : "/workspace",
      );
      const loaded = await loadConversation(session.sessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      setWorkspacePanelOpen(false);
      await Promise.all([
        refreshConversations(),
        refreshWorkspaces(),
        refreshDevelopmentEnvironments(),
      ]);
      if (pendingInitialPrompt !== null) {
        const accepted = await api.acceptTurn(
          session.sessionId,
          pendingInitialPrompt,
          newIdempotencyKey("turn"),
          "off",
        );
        update({ type: "turn.accepted", accepted, prompt: pendingInitialPrompt });
        setPrompt("");
      }
      setPendingInitialPrompt(null);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function openEnvironmentDirectoryPicker(): Promise<void> {
    const environment = developmentEnvironments.find(
      (candidate) => candidate.environmentId === selectedDevelopmentEnvironmentId,
    );
    if (environment === undefined || operation !== null) return;
    setOperation("managing-environment");
    update({ type: "api.error.cleared" });
    try {
      if (environment.state === "paused") {
        await api.developmentEnvironmentAction(
          environment.environmentId,
          "resume",
          newIdempotencyKey("environment"),
        );
        await refreshDevelopmentEnvironments();
      }
      setDirectoryPickerOpen(true);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
      await refreshDevelopmentEnvironments().catch(() => undefined);
    } finally {
      setOperation(null);
    }
  }

  async function deleteConversation(conversation: ConversationSummaryResource): Promise<void> {
    const deletesChildren =
      (conversationChildren.get(conversation.sessionId)?.length ?? 0) > 0 ||
      (delegatesByParent.get(conversation.sessionId)?.length ?? 0) > 0;
    if (
      operation !== null ||
      !window.confirm(
        deletesChildren
          ? t("chat.deleteTreeConfirm", { title: conversation.title })
          : t("chat.deleteConfirm", { title: conversation.title }),
      )
    ) {
      return;
    }
    setOperation("deleting-conversation");
    try {
      await api.deleteConversation(conversation.sessionId, newIdempotencyKey("delete"));
      if (state.session?.sessionId === conversation.sessionId) resetConversation();
      await Promise.all([refreshConversations(), refreshWorkspaces()]);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function rebindCurrentConversation(): Promise<void> {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined || operation !== null) return;
    setOperation("rebinding-workspace");
    update({ type: "api.error.cleared" });
    try {
      let targetWorkspaceId = selectedWorkspaceId;
      if (rebindWorkspaceChoice === "new") {
        const name = rebindWorkspaceName.trim();
        if (name.length === 0) return;
        targetWorkspaceId = (await api.createProject(name)).workspaceId;
      }
      if (targetWorkspaceId === "") return;
      await api.rebindConversationWorkspace(
        sessionId,
        targetWorkspaceId,
        newIdempotencyKey("workspace-rebind"),
      );
      const loaded = await loadConversation(sessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      setWorkspaceRebindOpen(false);
      setRebindWorkspaceName("");
      await Promise.all([refreshConversations(), refreshWorkspaces()]);
      focusComposer();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function createSshTicket(): Promise<void> {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined || operation !== null || currentTurn !== undefined) return;
    setOperation("managing-environment");
    update({ type: "api.error.cleared" });
    try {
      setSshTicket(await api.issueSshAccessTicket(sessionId));
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function submitTurn(): Promise<void> {
    const text = prompt.trim();
    if (!text || !canMutate || !canQueue || operation !== null) return;
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      let session = state.session;
      if (session === null) {
        setOperation(null);
        beginNewConversation(text);
        return;
      }
      const accepted = await api.acceptTurn(
        session.sessionId,
        text,
        newIdempotencyKey("turn"),
        "off",
      );
      update({ type: "turn.accepted", accepted, prompt: text });
      followConversationTail(true);
      setPrompt("");
      await refreshConversations();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function cancelTurn(): Promise<void> {
    if (state.session === null || currentTurn?.status !== "running" || operation !== null) return;
    setOperation("cancelling");
    try {
      await api.cancelTurn(
        state.session.sessionId,
        currentTurn.turnId,
        newIdempotencyKey("cancel"),
      );
      update({ type: "turn.cancellation.requested", turnId: currentTurn.turnId });
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function steerTurn(): Promise<void> {
    const text = prompt.trim();
    if (
      state.session === null ||
      currentTurn?.status !== "running" ||
      !text ||
      operation !== null
    ) {
      return;
    }
    setOperation("steering");
    setSteerNotice(null);
    update({ type: "api.error.cleared" });
    try {
      await api.steerTurn(
        state.session.sessionId,
        currentTurn.turnId,
        text,
        newIdempotencyKey("steer"),
      );
      setPrompt("");
      setSteerNotice(t("chat.steerAccepted"));
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  function renderDelegatedNode(
    delegated: DelegatedSessionSummaryResource,
    depth: number,
  ): ReactNode {
    const childDelegates = delegatesByParent.get(delegated.sessionId) ?? [];
    return (
      <div className="product-conversation-tree-node" key={delegated.executionId}>
        <div
          className={`product-conversation-row product-delegated-session ${delegated.contextMode}${
            state.session?.sessionId === delegated.sessionId ? " active" : ""
          }`}
          style={{ "--conversation-depth": depth } as CSSProperties}
        >
          <button
            disabled={conversationLoading !== null || operation !== null}
            onClick={() => void openDelegatedSession(delegated)}
            type="button"
          >
            <strong>
              <span className="product-conversation-branch-mark">
                {delegated.contextMode === "fork" ? "↳" : "⋯"}
              </span>
              {delegated.agentName} · Subagent
            </strong>
            <small>
              {t("chat.subagentDepth", { depth: delegated.depth })} ·{" "}
              {delegatedContextLabel(delegated.contextMode, t)} ·{" "}
              {delegatedWorkspaceLabel(delegated.workspaceMode, t)} ·{" "}
              {delegatedStateLabel(delegated.state, t)}
            </small>
          </button>
        </div>
        {childDelegates.map((child) => renderDelegatedNode(child, depth + 1))}
      </div>
    );
  }

  function renderConversationNode(conversation: ConversationSummaryResource, depth = 0): ReactNode {
    const childConversations = conversationChildren.get(conversation.sessionId) ?? [];
    const childDelegates = delegatesByParent.get(conversation.sessionId) ?? [];
    return (
      <div className="product-conversation-tree-node" key={conversation.sessionId}>
        <div
          className={`product-conversation-row${depth === 0 ? "" : " branch"}${
            state.session?.sessionId === conversation.sessionId ? " active" : ""
          }`}
          style={{ "--conversation-depth": depth } as CSSProperties}
        >
          <button
            disabled={conversationLoading !== null || operation !== null}
            onClick={() => void openConversation(conversation)}
            type="button"
          >
            <strong>
              {depth === 0 ? null : <span className="product-conversation-branch-mark">↳ </span>}
              {conversation.title}
            </strong>
            <small>
              {conversation.workspaceName} · {relativeTime(conversation.lastActiveAt, language, t)}
            </small>
          </button>
          <button
            aria-label={t("chat.deleteConversation", { title: conversation.title })}
            className="product-delete-conversation"
            disabled={conversationLoading !== null || operation !== null}
            onClick={() => void deleteConversation(conversation)}
            title={t("common.delete")}
            type="button"
          >
            ×
          </button>
        </div>
        {childConversations.map((child) => renderConversationNode(child, depth + 1))}
        {childDelegates.map((delegated) => renderDelegatedNode(delegated, depth + 1))}
      </div>
    );
  }

  if (authPhase === "checking") {
    return (
      <main className="product-loading-page">
        <div
          aria-label={t("chat.loadingIdentity")}
          className="product-loading-indicator"
          role="status"
        />
      </main>
    );
  }
  if (authPhase === "anonymous" || identity === null) {
    return (
      <AuthScreen
        api={api}
        onAuthenticated={(resolved) => {
          setIdentity(resolved);
          setAuthPhase("authenticated");
        }}
      />
    );
  }
  if (identity.platformAdministrator) {
    return <AdminPage api={api} identity={identity} onLogout={() => void logout()} />;
  }
  if (resourcePageOpen) {
    return (
      <ResourceManagementPage
        api={api}
        conversations={conversations}
        environments={developmentEnvironments}
        onClose={() => setResourcePageOpen(false)}
        onRefresh={async () => {
          await Promise.all([
            refreshConversations(),
            refreshWorkspaces(),
            refreshDevelopmentEnvironments(),
          ]);
        }}
        profiles={developmentProfiles}
        workspaces={workspaces}
      />
    );
  }
  return (
    <div className="product-shell">
      <button
        aria-label={t("chat.sidebar.close")}
        className={`product-sidebar-backdrop ${sidebarOpen ? "visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        type="button"
      />
      <aside
        className={`product-sidebar product-resizable-panel ${sidebarOpen ? "open" : ""}${
          conversationPanel.collapsed ? " collapsed" : ""
        }`}
        style={{ width: conversationPanel.collapsed ? 42 : conversationPanel.width }}
      >
        <button
          aria-label={
            conversationPanel.collapsed ? t("chat.sidebar.expand") : t("chat.sidebar.collapse")
          }
          className="product-panel-collapse"
          onClick={conversationPanel.toggle}
          title={
            conversationPanel.collapsed ? t("chat.sidebar.expand") : t("chat.sidebar.collapse")
          }
          type="button"
        >
          {conversationPanel.collapsed ? "›" : "‹"}
        </button>
        {conversationPanel.collapsed ? (
          <span className="product-collapsed-label">{t("chat.sidebar.label")}</span>
        ) : null}
        <div className="product-panel-content product-sidebar-content">
          <div className="product-sidebar-actions">
            <button
              className="product-new-chat"
              onClick={() => beginNewConversation()}
              type="button"
            >
              <span>＋</span> {t("chat.newConversation")}
            </button>
            <button
              className="product-resource-nav"
              onClick={() => setResourcePageOpen(true)}
              type="button"
            >
              <span>▦</span> {t("chat.resources")}
            </button>
          </div>
          <nav className="product-conversation-list" aria-label={t("chat.sidebar.label")}>
            <span className="product-sidebar-label">{t("chat.recent")}</span>
            {conversations.length === 0 ? (
              <div className="product-conversation-empty" aria-hidden="true" />
            ) : (
              rootConversations.map((conversation) => renderConversationNode(conversation))
            )}
          </nav>
          <footer className="product-account">
            <div className="product-account-avatar">
              {(identity.username ?? identity.displayName).slice(0, 1).toUpperCase()}
            </div>
            <strong>{identity.username ?? identity.displayName}</strong>
            <LanguageSelect compact />
            <button
              aria-label={t("chat.logout")}
              onClick={() => void logout()}
              title={t("chat.logout")}
              type="button"
            >
              ↪
            </button>
          </footer>
        </div>
        {conversationPanel.collapsed ? null : (
          <div
            aria-label={t("chat.sidebar.resize")}
            className="product-panel-resizer"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft")
                conversationPanel.setWidth(conversationPanel.width - 12);
              if (event.key === "ArrowRight")
                conversationPanel.setWidth(conversationPanel.width + 12);
            }}
            onPointerDown={conversationPanel.beginResize}
            role="separator"
            tabIndex={0}
          />
        )}
      </aside>

      <ConversationTreeNavigator
        loading={treeLoading}
        onNavigate={(sessionId, target) => {
          const delegated = conversationTree?.delegatedSessions.find(
            (candidate) => candidate.sessionId === sessionId,
          );
          void openConversationSession(sessionId, target, false, delegated ?? null);
        }}
        onViewChange={setTreeView}
        scrollerRef={chatScrollerRef}
        tree={conversationTree}
        view={treeView}
      />

      <main className="product-main">
        <header className="product-topbar">
          <button
            className="product-mobile-menu"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            ☰
          </button>
          <div className="product-topbar-title">
            <strong>{state.session?.title ?? t("chat.newConversation")}</strong>
            {selectedDelegatedSession === null ? null : (
              <span className="product-delegated-title">
                {selectedDelegatedSession.agentName} ·{" "}
                {delegatedContextLabel(selectedDelegatedSession.contextMode, t)} ·{" "}
                {delegatedWorkspaceLabel(selectedDelegatedSession.workspaceMode, t)} ·{" "}
                {t("chat.readOnly")}
              </span>
            )}
            {state.project ? (
              <span>
                {currentDevelopmentEnvironment === undefined
                  ? `/workspace · ${state.project.name} · ${t("chat.elastic")}`
                  : `${state.session?.workingDirectory ?? "/workspace"} · ${t("chat.exclusive", {
                      id: currentDevelopmentEnvironment.environmentId.slice(0, 8),
                    })} · ${String(currentDevelopmentEnvironment.cpuCount)}C/${String(
                      currentDevelopmentEnvironment.memoryMiB / 1024,
                    )}G`}
                {state.session?.workspaceState === "missing"
                  ? ` · ${t("chat.workspaceDeleted")}`
                  : ""}
              </span>
            ) : null}
            {state.session ? (
              <span className={state.connection.phase === "live" ? "online" : ""}>
                {state.connection.phase === "live" ? t("chat.connected") : t("chat.connecting")}
              </span>
            ) : null}
            {state.session?.sandboxRetention !== "persistent" ||
            currentDevelopmentEnvironment?.state !== "running" ? null : (
              <div className="product-environment-controls">
                <button
                  disabled={currentTurn !== undefined || operation !== null}
                  onClick={() => void createSshTicket()}
                  title={t("chat.sshExclusiveOnly")}
                  type="button"
                >
                  {t("chat.ssh")}
                </button>
              </div>
            )}
          </div>
          <div className="product-topbar-actions">
            {state.connection.phase === "failed" ? (
              <button onClick={() => setReconnectGeneration((value) => value + 1)} type="button">
                {t("chat.reconnect")}
              </button>
            ) : null}
            <button
              disabled={state.session === null || selectedDelegatedSession !== null}
              onClick={() => setInspectorOpen((value) => !value)}
              title={
                selectedDelegatedSession === null
                  ? t("chat.inspectWorkspace")
                  : t("chat.inspectParentWorkspace")
              }
              type="button"
            >
              {t("chat.workspaceButton")}
            </button>
          </div>
        </header>

        {workspacePanelOpen ? (
          <div className="product-modal-backdrop" role="presentation">
            <form
              className="product-workspace-modal"
              onSubmit={(event) => {
                event.preventDefault();
                void createConversation();
              }}
            >
              <header>
                <div>
                  <h2>{t("chat.create.title")}</h2>
                </div>
                <button
                  onClick={() => {
                    setWorkspacePanelOpen(false);
                    setPendingInitialPrompt(null);
                  }}
                  type="button"
                >
                  ×
                </button>
              </header>
              <fieldset className="product-workspace-choice product-execution-mode-choice">
                <legend>{t("chat.create.executionMode")}</legend>
                <label className="product-choice-card">
                  <input
                    checked={executionMode === "elastic"}
                    onChange={() => setExecutionMode("elastic")}
                    type="radio"
                  />
                  <span>
                    <strong>{t("chat.create.elasticRecommended")}</strong>
                  </span>
                </label>
                <label className="product-choice-card">
                  <input
                    checked={executionMode === "exclusive"}
                    onChange={() => {
                      setExecutionMode("exclusive");
                      setWorkingDirectory(DEFAULT_EXCLUSIVE_WORKING_DIRECTORY);
                    }}
                    type="radio"
                  />
                  <span>
                    <strong>{t("chat.create.exclusive")}</strong>
                  </span>
                </label>
              </fieldset>

              {executionMode === null ? null : (
                <div className="product-progressive-options">
                  <label>
                    <span>{t("chat.create.conversationTitle")}</span>
                    <input
                      autoFocus
                      maxLength={256}
                      onChange={(event) => setNewConversationTitle(event.target.value)}
                      placeholder={t("chat.create.titlePlaceholder")}
                      required
                      value={newConversationTitle}
                    />
                  </label>

                  {executionMode === "elastic" ? (
                    <fieldset className="product-workspace-choice">
                      <legend>Workspace</legend>
                      <label>
                        <span>{t("chat.create.workspaceSelect")}</span>
                        <select
                          onChange={(event) => {
                            const value = event.target.value;
                            setWorkspaceChoice(value === "__new__" ? "new" : "existing");
                            if (value !== "__new__") setSelectedWorkspaceId(value);
                          }}
                          value={workspaceChoice === "new" ? "__new__" : selectedWorkspaceId}
                        >
                          {elasticWorkspaces.map((workspace) => (
                            <option key={workspace.workspaceId} value={workspace.workspaceId}>
                              {t("chat.create.workspaceSessions", {
                                name: workspace.name,
                                count: workspace.sessionCount,
                              })}
                            </option>
                          ))}
                          <option value="__new__">{t("chat.create.newWorkspace")}</option>
                        </select>
                      </label>
                      {workspaceChoice === "new" ? (
                        <label>
                          <span>{t("chat.create.workspaceName")}</span>
                          <input
                            maxLength={256}
                            onChange={(event) => setNewWorkspaceName(event.target.value)}
                            placeholder={t("chat.create.workspacePlaceholder")}
                            required
                            value={newWorkspaceName}
                          />
                        </label>
                      ) : null}
                      <legend>{t("chat.create.elasticProfile")}</legend>
                      <div
                        className="product-resource-profiles"
                        role="radiogroup"
                        aria-label={t("chat.create.elasticProfile")}
                      >
                        {developmentProfiles.map((profile) => (
                          <button
                            aria-checked={profile.key === developmentProfileKey}
                            className={profile.key === developmentProfileKey ? "active" : ""}
                            key={profile.key}
                            onClick={() => setDevelopmentProfileKey(profile.key)}
                            role="radio"
                            type="button"
                          >
                            <span>
                              <strong>
                                {String(profile.cpuCount)}C / {String(profile.memoryMiB / 1024)}G
                              </strong>
                              {profile.recommended ? <em>{t("chat.create.recommended")}</em> : null}
                            </span>
                            <small>
                              {t("chat.create.systemDisk", { size: profile.systemDiskGiB })}
                            </small>
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ) : (
                    <fieldset className="product-workspace-choice product-exclusive-environment-choice">
                      <legend>{t("chat.create.exclusive")}</legend>
                      {selectableDevelopmentEnvironments.length === 0 ? (
                        <div className="product-resource-boundary-note">
                          {t("chat.create.noExclusive")}
                          <button
                            onClick={() => {
                              setWorkspacePanelOpen(false);
                              setResourcePageOpen(true);
                            }}
                            type="button"
                          >
                            {t("chat.create.openResources")}
                          </button>
                        </div>
                      ) : (
                        <>
                          <label>
                            <span>{t("chat.create.selectExclusive")}</span>
                            <select
                              onChange={(event) => {
                                setSelectedDevelopmentEnvironmentId(event.target.value);
                                setWorkingDirectory(DEFAULT_EXCLUSIVE_WORKING_DIRECTORY);
                              }}
                              value={selectedDevelopmentEnvironmentId}
                            >
                              {selectableDevelopmentEnvironments.map((environment) => (
                                <option
                                  key={environment.environmentId}
                                  value={environment.environmentId}
                                >
                                  {t("chat.create.exclusiveOption", {
                                    id: environment.environmentId.slice(0, 8),
                                    cpu: environment.cpuCount,
                                    memory: environment.memoryMiB / 1024,
                                    state: developmentStateLabel(environment.state, t),
                                  })}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="product-working-directory-choice">
                            <div>
                              <span>{t("chat.create.workingDirectory")}</span>
                              <code>{workingDirectory}</code>
                            </div>
                            <button
                              onClick={() => void openEnvironmentDirectoryPicker()}
                              type="button"
                            >
                              {t("chat.create.chooseDirectory")}
                            </button>
                          </div>
                        </>
                      )}
                    </fieldset>
                  )}
                </div>
              )}
              <footer>
                <button
                  onClick={() => {
                    setWorkspacePanelOpen(false);
                    setPendingInitialPrompt(null);
                  }}
                  type="button"
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="product-primary-button"
                  disabled={
                    operation !== null ||
                    executionMode === null ||
                    (executionMode === "exclusive" && selectedDevelopmentEnvironmentId === "") ||
                    (executionMode === "elastic" &&
                      workspaceChoice === "new" &&
                      newWorkspaceName.trim() === "")
                  }
                  type="submit"
                >
                  {operation === "creating" ? t("chat.create.creating") : t("chat.create.submit")}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

        {directoryPickerOpen
          ? (() => {
              const environment = selectableDevelopmentEnvironments.find(
                (candidate) => candidate.environmentId === selectedDevelopmentEnvironmentId,
              );
              if (environment === undefined) return null;
              return (
                <WorkspaceDirectoryPicker
                  api={api}
                  environmentId={environment.environmentId}
                  initialDirectory={workingDirectory}
                  onCancel={() => setDirectoryPickerOpen(false)}
                  onChoose={(directory) => {
                    setWorkingDirectory(directory);
                    setDirectoryPickerOpen(false);
                  }}
                  workspaceName={t("chat.exclusive", {
                    id: environment.environmentId.slice(0, 8),
                  })}
                />
              );
            })()
          : null}

        {workspaceRebindOpen && state.session?.workspaceState === "missing" ? (
          <div className="product-modal-backdrop" role="presentation">
            <form
              className="product-workspace-modal product-rebind-modal"
              onSubmit={(event) => {
                event.preventDefault();
                void rebindCurrentConversation();
              }}
            >
              <header>
                <div>
                  <h2>{t("chat.rebind.title")}</h2>
                  <p>{t("chat.rebind.description")}</p>
                </div>
                <button onClick={() => setWorkspaceRebindOpen(false)} type="button">
                  ×
                </button>
              </header>
              <fieldset className="product-workspace-choice">
                <legend>{t("chat.rebind.workspace")}</legend>
                {elasticWorkspaces.length > 0 ? (
                  <label className="product-choice-card">
                    <input
                      checked={rebindWorkspaceChoice === "existing"}
                      onChange={() => setRebindWorkspaceChoice("existing")}
                      type="radio"
                    />
                    <span>
                      <strong>{t("chat.rebind.existing")}</strong>
                      <small>{t("chat.rebind.existingDescription")}</small>
                    </span>
                  </label>
                ) : null}
                {rebindWorkspaceChoice === "existing" && elasticWorkspaces.length > 0 ? (
                  <select
                    onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                    value={selectedWorkspaceId}
                  >
                    {elasticWorkspaces.map((workspace) => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className="product-choice-card">
                  <input
                    checked={rebindWorkspaceChoice === "new"}
                    onChange={() => setRebindWorkspaceChoice("new")}
                    type="radio"
                  />
                  <span>
                    <strong>{t("chat.rebind.new")}</strong>
                    <small>{t("chat.rebind.newDescription")}</small>
                  </span>
                </label>
                {rebindWorkspaceChoice === "new" ? (
                  <input
                    maxLength={256}
                    onChange={(event) => setRebindWorkspaceName(event.target.value)}
                    placeholder={t("chat.rebind.placeholder")}
                    value={rebindWorkspaceName}
                  />
                ) : null}
              </fieldset>
              <footer>
                <button onClick={() => setWorkspaceRebindOpen(false)} type="button">
                  {t("common.cancel")}
                </button>
                <button
                  className="product-primary-button"
                  disabled={
                    operation !== null ||
                    (rebindWorkspaceChoice === "existing" && selectedWorkspaceId === "") ||
                    (rebindWorkspaceChoice === "new" && rebindWorkspaceName.trim() === "")
                  }
                  type="submit"
                >
                  {operation === "rebinding-workspace"
                    ? t("chat.rebind.binding")
                    : t("chat.rebind.submit")}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

        {sshTicket === null ? null : (
          <div className="product-modal-backdrop" role="presentation">
            <section className="product-workspace-modal product-ssh-ticket-modal">
              <header>
                <div>
                  <h2>{t("chat.ssh.title")}</h2>
                  <p>
                    {t("chat.ssh.expires", {
                      time: new Date(sshTicket.expiresAt).toLocaleString(language),
                    })}
                  </p>
                </div>
                <button onClick={() => setSshTicket(null)} type="button">
                  ×
                </button>
              </header>
              <label>
                <span>{t("chat.ssh.oneLine")}</span>
                <code>{sshTicket.oneLineCommand}</code>
              </label>
              <label>
                <span>{t("chat.ssh.manual")}</span>
                <code>{sshTicket.command}</code>
              </label>
              <p className="product-resource-boundary-note">{t("chat.ssh.warning")}</p>
              <footer>
                <button
                  onClick={() => void navigator.clipboard.writeText(sshTicket.oneLineCommand)}
                  type="button"
                >
                  {t("chat.ssh.copyCommand")}
                </button>
                <button
                  className="product-primary-button"
                  onClick={() => void navigator.clipboard.writeText(sshTicket.password)}
                  type="button"
                >
                  {t("chat.ssh.copyPassword")}
                </button>
              </footer>
            </section>
          </div>
        )}

        {forkTarget === null ? null : (
          <div className="product-modal-backdrop" role="presentation">
            <form
              className="product-workspace-modal product-fork-modal"
              onSubmit={(event) => {
                event.preventDefault();
                void createConversationFork();
              }}
            >
              <header>
                <div>
                  <h2>{t("chat.fork.title")}</h2>
                  <p>{t("chat.fork.description")}</p>
                </div>
                <button
                  onClick={() => {
                    setForkTarget(null);
                    setForkTitle("");
                  }}
                  type="button"
                >
                  ×
                </button>
              </header>
              <label>
                <span>{t("chat.fork.name")}</span>
                <input
                  autoFocus
                  maxLength={256}
                  onChange={(event) => setForkTitle(event.target.value)}
                  placeholder={t("chat.fork.placeholder")}
                  value={forkTitle}
                />
              </label>
              <p className="product-fork-note">{t("chat.fork.warning")}</p>
              <footer>
                <button
                  onClick={() => {
                    setForkTarget(null);
                    setForkTitle("");
                  }}
                  type="button"
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="product-primary-button"
                  disabled={operation !== null}
                  type="submit"
                >
                  {operation === "forking" ? t("chat.fork.creating") : t("chat.fork.submit")}
                </button>
              </footer>
            </form>
          </div>
        )}

        {state.apiError ? (
          <div className="product-error-banner">
            <span>{state.apiError}</span>
            <button onClick={() => update({ type: "api.error.cleared" })} type="button">
              ×
            </button>
          </div>
        ) : null}

        {state.session?.workspaceState === "missing" ? (
          <div className="product-workspace-missing-banner">
            <span>{t("chat.missingWorkspace")}</span>
            <button
              disabled={!canMutate}
              onClick={() => {
                setSelectedWorkspaceId(elasticWorkspaces[0]?.workspaceId ?? "");
                setRebindWorkspaceChoice(elasticWorkspaces.length === 0 ? "new" : "existing");
                setRebindWorkspaceName("");
                setWorkspaceRebindOpen(true);
              }}
              type="button"
            >
              {t("chat.chooseWorkspace")}
            </button>
          </div>
        ) : null}

        <div className={`product-content ${inspectorOpen ? "with-inspector" : ""}`}>
          <section
            className="product-chat-scroll"
            onScroll={(event) => {
              const follows = isConversationTailVisible(event.currentTarget);
              if (follows !== followingConversationTailRef.current) {
                followConversationTail(follows);
              }
            }}
            ref={chatScrollerRef}
          >
            {state.turns.length === 0 ? (
              <div className="product-chat-empty" aria-hidden="true" />
            ) : (
              <div className="product-transcript">
                {state.inheritedMessages.length === 0 ? null : (
                  <section className="product-inherited-context">
                    <header>
                      <strong>{t("chat.inherited.title")}</strong>
                      <span>{t("chat.inherited.description")}</span>
                    </header>
                    {state.inheritedMessages.map((message) => (
                      <div
                        className={`product-inherited-message ${message.role}`}
                        data-conversation-entry-id={message.entryId}
                        key={message.entryId}
                      >
                        {message.role === "user" ? (
                          <div className="product-user-bubble">{message.text}</div>
                        ) : (
                          <div className="product-inherited-assistant">
                            <span className="product-avatar">A</span>
                            <div className="product-assistant-content">
                              <Markdown sessionId={selectedDelegatedSession?.sessionId}>
                                {message.text}
                              </Markdown>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="product-inherited-divider">
                      <span>{t("chat.inherited.divider")}</span>
                    </div>
                  </section>
                )}
                {state.turns.map((turn) => {
                  const target = forkTargets.get(turn.turnId);
                  return (
                    <ConversationTurn
                      canFork={
                        canMutate &&
                        operation === null &&
                        currentTurn === undefined &&
                        target !== undefined
                      }
                      canPrune={
                        canMutate &&
                        operation === null &&
                        currentTurn === undefined &&
                        target !== undefined &&
                        target.sourceSessionId === state.session?.sessionId
                      }
                      key={turn.turnId}
                      onPresentationProgress={followProgressiveText}
                      sessionId={selectedDelegatedSession?.sessionId ?? state.session?.sessionId}
                      {...(target === undefined
                        ? {}
                        : {
                            onFork: () => {
                              setForkTitle("");
                              setForkTarget(target);
                            },
                            onPrune: () => void pruneConversationTail(target),
                          })}
                      turn={turn}
                    />
                  );
                })}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </section>
          {followingConversationTail || state.turns.length === 0 ? null : (
            <button
              className="product-return-to-latest"
              onClick={() => {
                followConversationTail(true);
                const scroller = chatScrollerRef.current;
                scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
              }}
              type="button"
            >
              {t("chat.latest")}
            </button>
          )}
          {inspectorOpen ? (
            <WorkspaceInspector
              api={api}
              onClose={() => setInspectorOpen(false)}
              onError={(message) => update({ type: "api.error", message })}
              refreshSignal={inspectorRefreshSignal}
              sessionId={state.session?.sessionId ?? null}
              workspaceId={state.project?.workspaceId ?? null}
              workspaceName={state.project?.name ?? null}
            />
          ) : null}
        </div>

        <footer className="product-composer-area">
          {selectedDelegatedSession === null ? null : (
            <div className="product-delegated-readonly">{t("chat.subagentReadOnly")}</div>
          )}
          <div className="product-composer">
            <textarea
              aria-label={t("chat.sendLabel")}
              disabled={!canMutate || !canQueue}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitTurn();
                }
              }}
              placeholder={currentTurn ? t("chat.queuePlaceholder") : t("chat.promptPlaceholder")}
              ref={composerRef}
              rows={1}
              value={prompt}
            />
            {currentTurn?.status === "running" ? (
              <>
                <button
                  className="product-steer-button"
                  disabled={!prompt.trim() || operation !== null}
                  onClick={() => void steerTurn()}
                  title={t("chat.steerTitle")}
                  type="button"
                >
                  {t("chat.steer")}
                </button>
                <button
                  className="product-stop-button"
                  onClick={() => void cancelTurn()}
                  title={t("chat.stop")}
                  type="button"
                >
                  ■
                </button>
              </>
            ) : (
              <button
                className="product-send-button"
                disabled={!prompt.trim() || !canQueue || operation !== null}
                onClick={() => void submitTurn()}
                title={t("chat.send")}
                type="button"
              >
                ↑
              </button>
            )}
          </div>
          {steerNotice === null ? null : (
            <small className="product-steer-notice">{steerNotice}</small>
          )}
        </footer>
      </main>
    </div>
  );
}
