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
import { SANDBOX_PREVIEW_PORTS } from "@pi-cloud/protocol";
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
import { useResizablePanel } from "./use-resizable-panel.ts";

type AuthPhase = "checking" | "anonymous" | "authenticated";

const EXAMPLE_PROMPTS = [
  "帮我分析这个项目，并说明它的核心架构",
  "实现一个 REST API，并补充单元测试",
  "检查当前代码中的 bug，修复后运行测试",
] as const;

function conversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact || "新对话";
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))} 分钟前`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))} 小时前`;
  if (seconds < 604_800) return `${String(Math.floor(seconds / 86_400))} 天前`;
  return new Date(value).toLocaleDateString();
}

function delegatedContextLabel(mode: DelegatedSessionSummaryResource["contextMode"]): string {
  return mode === "fork" ? "继承上下文" : "独立上下文";
}

function delegatedWorkspaceLabel(mode: DelegatedSessionSummaryResource["workspaceMode"]): string {
  if (mode === "shared_serialized") return "共享工作区";
  if (mode === "isolated") return "隔离工作区";
  return "无工具";
}

export default function ChatApp() {
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
    | "deleting-workspace"
    | "rebinding-workspace"
    | "managing-environment"
    | null
  >(null);
  const [steerNotice, setSteerNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspaceRebindOpen, setWorkspaceRebindOpen] = useState(false);
  const [rebindWorkspaceChoice, setRebindWorkspaceChoice] = useState<"existing" | "new">(
    "existing",
  );
  const [rebindWorkspaceName, setRebindWorkspaceName] = useState("");
  const [previewPort, setPreviewPort] = useState("8000");
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const [sshTicket, setSshTicket] = useState<SshAccessTicketResource | null>(null);
  const [followingConversationTail, setFollowingConversationTail] = useState(true);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState<"existing" | "new">("new");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [executionMode, setExecutionMode] = useState<"elastic" | "exclusive">("elastic");
  const [exclusiveChoice, setExclusiveChoice] = useState<"existing" | "new">("new");
  const [selectedDevelopmentEnvironmentId, setSelectedDevelopmentEnvironmentId] = useState("");
  const [developmentProfileKey, setDevelopmentProfileKey] =
    useState<DevelopmentEnvironmentProfileKey>("standard");
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
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === selectedWorkspaceId,
  );
  const currentDevelopmentEnvironment = developmentEnvironments.find(
    (environment) =>
      environment.workspaceId === state.session?.workspaceId &&
      ["requested", "provisioning", "running", "paused", "releasing", "failed", "unknown"].includes(
        environment.state,
      ),
  );
  const selectableDevelopmentEnvironments = developmentEnvironments.filter((environment) =>
    ["running", "paused"].includes(environment.state),
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
        if (!cancelled) update({ type: "api.error", message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, identity?.platformAdministrator, identity?.tenantId, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshWorkspaces().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error) });
    });
  }, [authPhase, identity?.platformAdministrator, identity?.tenantId, refreshWorkspaces, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshDevelopmentEnvironments().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error) });
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
          if (!cancelled) update({ type: "api.error", message: errorMessage(error) });
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
        update({ type: "api.error", message: "实时连接已中断，正在等待重新连接。" });
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
      setSelectedDelegatedSession(delegatedSession);
      if (jumpTarget !== undefined) setPendingTreeJump(jumpTarget);
      setSidebarOpen(false);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
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
      update({ type: "api.error", message: errorMessage(error) });
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
      !window.confirm(
        "保留这条回复，删除它之后的对话、分支和 Subagent 记录？Workspace 文件不会回滚。",
      )
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
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  function beginNewConversation(initialPrompt: string | null = null): void {
    resetConversation();
    setPendingInitialPrompt(initialPrompt);
    setNewConversationTitle(initialPrompt === null ? "" : conversationTitle(initialPrompt));
    setWorkspaceChoice(workspaces.length === 0 ? "new" : "existing");
    setSelectedWorkspaceId(workspaces[0]?.workspaceId ?? "");
    setNewWorkspaceName("");
    setExecutionMode("elastic");
    setExclusiveChoice(selectableDevelopmentEnvironments.length === 0 ? "new" : "existing");
    setSelectedDevelopmentEnvironmentId(selectableDevelopmentEnvironments[0]?.environmentId ?? "");
    setDevelopmentProfileKey("standard");
    setWorkspacePanelOpen(true);
  }

  async function createConversation(): Promise<void> {
    const title = newConversationTitle.trim();
    if (title.length === 0 || operation !== null) return;
    setOperation("managing-environment");
    update({ type: "api.error.cleared" });
    try {
      let projectId: string;
      let workspaceId: string;
      const existingEnvironment =
        executionMode === "exclusive" && exclusiveChoice === "existing"
          ? selectableDevelopmentEnvironments.find(
              (environment) => environment.environmentId === selectedDevelopmentEnvironmentId,
            )
          : undefined;
      if (
        executionMode === "exclusive" &&
        exclusiveChoice === "existing" &&
        existingEnvironment === undefined
      ) {
        update({ type: "api.error", message: "请选择一个可用的独享运行环境。" });
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
        const selected = workspaces.find(
          (workspace) => workspace.workspaceId === selectedWorkspaceId,
        );
        if (selected === undefined) {
          update({ type: "api.error", message: "请选择一个 Workspace。" });
          return;
        }
        projectId = selected.projectId;
        workspaceId = selected.workspaceId;
      }
      if (executionMode === "exclusive" && existingEnvironment === undefined) {
        await api.createDevelopmentEnvironment(
          workspaceId,
          developmentProfileKey,
          newIdempotencyKey("environment"),
        );
      }
      const session = await api.createSession(projectId, workspaceId, title, "ephemeral");
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
      update({ type: "api.error", message: errorMessage(error) });
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
          ? `删除对话“${conversation.title}”及其全部分支和 Subagent？Workspace 文件不会被删除。`
          : `删除对话“${conversation.title}”？Workspace 文件不会被删除。`,
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
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function deleteWorkspace(workspace: WorkspaceSummaryResource): Promise<void> {
    if (
      operation !== null ||
      !window.confirm(
        `永久删除 Workspace“${workspace.name}”及其中的全部文件？${
          workspace.sessionCount > 0
            ? `关联的 ${String(workspace.sessionCount)} 个对话会保留，并在下次继续前要求选择新的 Workspace。`
            : ""
        }此操作无法撤销。`,
      )
    ) {
      return;
    }
    setOperation("deleting-workspace");
    update({ type: "api.error.cleared" });
    try {
      await api.deleteWorkspace(workspace.workspaceId, newIdempotencyKey("delete"));
      await Promise.all([refreshWorkspaces(), refreshConversations()]);
      if (workspaces.length === 1) setWorkspaceChoice("new");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
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
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function openConversationPreview(): Promise<void> {
    const sessionId = state.session?.sessionId;
    const port = Number(previewPort);
    if (sessionId === undefined || !Number.isSafeInteger(port)) return;
    setPreviewNotice("正在检查沙箱服务…");
    try {
      const path = await api.probeConversationPreview(sessionId, port);
      setPreviewNotice(null);
      window.open(path, "_blank", "noopener,noreferrer");
    } catch (error: unknown) {
      setPreviewNotice(
        error instanceof PiCloudApiError && error.code === "preview_unavailable"
          ? `端口 ${String(port)} 尚未监听。请让应用绑定 0.0.0.0:${String(port)} 后重试。`
          : errorMessage(error),
      );
    }
  }

  async function manageCurrentEnvironment(
    action: "start" | "pause" | "resume" | "release",
  ): Promise<void> {
    const environment = currentDevelopmentEnvironment;
    if (
      environment === undefined ||
      operation !== null ||
      currentTurn !== undefined ||
      (action === "release" &&
        !window.confirm("释放这台 Cube KVM？对话和 Workspace 文件会保留，后台进程会停止。"))
    ) {
      return;
    }
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      await api.developmentEnvironmentAction(
        environment.environmentId,
        action,
        newIdempotencyKey("environment"),
      );
      await refreshDevelopmentEnvironments();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
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
      update({ type: "api.error", message: errorMessage(error) });
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
      update({ type: "api.error", message: errorMessage(error) });
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
      update({ type: "api.error", message: errorMessage(error) });
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
      setSteerNotice("已引导当前任务；Pi 会在当前工具调用结束后、下一次模型调用前处理。");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
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
              第 {delegated.depth} 层 · {delegatedContextLabel(delegated.contextMode)} ·{" "}
              {delegatedWorkspaceLabel(delegated.workspaceMode)} · {delegated.state}
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
              {conversation.workspaceName} · {relativeTime(conversation.lastActiveAt)}
            </small>
          </button>
          <button
            aria-label={`删除对话 ${conversation.title}`}
            className="product-delete-conversation"
            disabled={conversationLoading !== null || operation !== null}
            onClick={() => void deleteConversation(conversation)}
            title="删除对话"
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
        <div className="product-logo product-logo-large">A</div>
        <span>PiCloud · 正在恢复登录状态…</span>
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
  return (
    <div className="product-shell">
      <button
        aria-label="关闭侧边栏"
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
          aria-label={conversationPanel.collapsed ? "展开会话列表" : "收起会话列表"}
          className="product-panel-collapse"
          onClick={conversationPanel.toggle}
          title={conversationPanel.collapsed ? "展开会话列表" : "收起会话列表"}
          type="button"
        >
          {conversationPanel.collapsed ? "›" : "‹"}
        </button>
        {conversationPanel.collapsed ? <span className="product-collapsed-label">会话</span> : null}
        <div className="product-panel-content product-sidebar-content">
          <header className="product-sidebar-brand">
            <div className="product-logo">A</div>
            <strong>PiCloud</strong>
          </header>
          <div className="product-sidebar-actions">
            <button
              className="product-new-chat"
              onClick={() => beginNewConversation()}
              type="button"
            >
              <span>＋</span> 新对话
            </button>
          </div>
          <nav className="product-conversation-list" aria-label="对话列表">
            <span className="product-sidebar-label">最近对话</span>
            {conversations.length === 0 ? (
              <div className="product-conversation-empty">还没有对话</div>
            ) : (
              rootConversations.map((conversation) => renderConversationNode(conversation))
            )}
          </nav>
          <footer className="product-account">
            <div className="product-account-avatar">
              {identity.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{identity.displayName}</strong>
              <span>@{identity.tenantSlug}</span>
            </div>
            <button
              aria-label="退出登录"
              onClick={() => void logout()}
              title="退出登录"
              type="button"
            >
              ↪
            </button>
          </footer>
        </div>
        {conversationPanel.collapsed ? null : (
          <div
            aria-label="调整会话列表宽度"
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
            <strong>{state.session?.title ?? "新对话"}</strong>
            {selectedDelegatedSession === null ? null : (
              <span className="product-delegated-title">
                {selectedDelegatedSession.agentName} ·{" "}
                {delegatedContextLabel(selectedDelegatedSession.contextMode)} ·{" "}
                {delegatedWorkspaceLabel(selectedDelegatedSession.workspaceMode)} · 只读
              </span>
            )}
            {state.project ? (
              <span>
                /workspace · {state.project.name}
                {currentDevelopmentEnvironment === undefined
                  ? state.session?.sandboxRetention === "persistent"
                    ? " · 旧版持久沙箱"
                    : " · 弹性执行"
                  : ` · 独享 ${String(currentDevelopmentEnvironment.cpuCount)}C/${String(
                      currentDevelopmentEnvironment.memoryMiB / 1024,
                    )}G`}
                {state.session?.workspaceState === "missing" ? " · Workspace 已删除" : ""}
              </span>
            ) : null}
            {state.session ? (
              <span className={state.connection.phase === "live" ? "online" : ""}>
                {state.connection.phase === "live" ? "已连接" : "连接中"}
              </span>
            ) : null}
            {state.session?.sandboxRetention === "persistent" ||
            currentDevelopmentEnvironment?.state === "running" ? (
              <div className="product-preview-control">
                <label title="沙箱内应用监听的 HTTP 端口">
                  服务端口
                  <select
                    aria-label="预览端口"
                    onChange={(event) => setPreviewPort(event.target.value)}
                    value={previewPort}
                  >
                    {SANDBOX_PREVIEW_PORTS.map((port) => (
                      <option key={port} value={port}>
                        {port}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="product-preview-link"
                  onClick={() => void openConversationPreview()}
                  type="button"
                >
                  打开预览 ↗
                </button>
                {previewNotice === null ? null : (
                  <span className="product-preview-notice">{previewNotice}</span>
                )}
              </div>
            ) : null}
            {currentDevelopmentEnvironment === undefined ? null : (
              <div className="product-environment-controls">
                {currentDevelopmentEnvironment.state === "running" ? (
                  <>
                    <button
                      disabled={currentTurn !== undefined || operation !== null}
                      onClick={() => void createSshTicket()}
                      type="button"
                    >
                      SSH
                    </button>
                    <button
                      disabled={currentTurn !== undefined || operation !== null}
                      onClick={() => void manageCurrentEnvironment("pause")}
                      type="button"
                    >
                      暂停环境
                    </button>
                  </>
                ) : currentDevelopmentEnvironment.state === "paused" ? (
                  <button
                    disabled={currentTurn !== undefined || operation !== null}
                    onClick={() => void manageCurrentEnvironment("resume")}
                    type="button"
                  >
                    恢复环境
                  </button>
                ) : currentDevelopmentEnvironment.state === "failed" ? (
                  <button
                    disabled={currentTurn !== undefined || operation !== null}
                    onClick={() => void manageCurrentEnvironment("start")}
                    type="button"
                  >
                    重建环境
                  </button>
                ) : null}
                {["running", "paused", "requested", "failed", "unknown"].includes(
                  currentDevelopmentEnvironment.state,
                ) ? (
                  <button
                    className="product-danger-button"
                    disabled={currentTurn !== undefined || operation !== null}
                    onClick={() => void manageCurrentEnvironment("release")}
                    type="button"
                  >
                    释放环境
                  </button>
                ) : (
                  <span className="product-preview-notice">环境正在准备，请稍候…</span>
                )}
              </div>
            )}
          </div>
          <div className="product-topbar-actions">
            {state.connection.phase === "failed" ? (
              <button onClick={() => setReconnectGeneration((value) => value + 1)} type="button">
                重新连接
              </button>
            ) : null}
            <button
              disabled={state.session === null || selectedDelegatedSession !== null}
              onClick={() => setInspectorOpen((value) => !value)}
              title={
                selectedDelegatedSession === null
                  ? "查看 Workspace"
                  : "Subagent 执行记录为只读；请从父会话查看 Workspace"
              }
              type="button"
            >
              工作区
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
                  <h2>新建对话</h2>
                  <p>先选择计算方式，再把对话绑定到一个可替换的 Workspace。</p>
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
              <label>
                <span>对话标题</span>
                <input
                  autoFocus
                  maxLength={256}
                  onChange={(event) => setNewConversationTitle(event.target.value)}
                  placeholder="例如：修复订单服务的并发问题"
                  required
                  value={newConversationTitle}
                />
              </label>
              <fieldset className="product-workspace-choice product-execution-mode-choice">
                <legend>运行方式</legend>
                <label className="product-choice-card">
                  <input
                    checked={executionMode === "elastic"}
                    onChange={() => setExecutionMode("elastic")}
                    type="radio"
                  />
                  <span>
                    <strong>弹性执行（推荐）</strong>
                    <small>需要工具时分配 Cube 计算资源；空闲后回收，Workspace 文件独立保留</small>
                  </span>
                </label>
                <label className="product-choice-card">
                  <input
                    checked={executionMode === "exclusive"}
                    onChange={() => setExecutionMode("exclusive")}
                    type="radio"
                  />
                  <span>
                    <strong>独享运行环境</strong>
                    <small>申请或选择仅你可见的 Cube KVM，跨多轮保留后台进程、服务和终端状态</small>
                  </span>
                </label>
                {executionMode === "exclusive" ? (
                  <p className="product-resource-boundary-note">
                    Cube 是计算与进程环境；Workspace 是挂载其中的持久文件卷。释放或故障重建 Cube
                    不会删除对话，也不会删除 Workspace 文件。
                  </p>
                ) : null}
              </fieldset>

              {executionMode === "exclusive" ? (
                <fieldset className="product-workspace-choice product-exclusive-environment-choice">
                  <legend>独享运行环境</legend>
                  {selectableDevelopmentEnvironments.length > 0 ? (
                    <label className="product-choice-card">
                      <input
                        checked={exclusiveChoice === "existing"}
                        onChange={() => setExclusiveChoice("existing")}
                        type="radio"
                      />
                      <span>
                        <strong>使用已有环境</strong>
                        <small>继续使用同一台 KVM 中的进程、服务和 Workspace</small>
                      </span>
                    </label>
                  ) : null}
                  {exclusiveChoice === "existing" &&
                  selectableDevelopmentEnvironments.length > 0 ? (
                    <label>
                      <span>环境</span>
                      <select
                        onChange={(event) =>
                          setSelectedDevelopmentEnvironmentId(event.target.value)
                        }
                        value={selectedDevelopmentEnvironmentId}
                      >
                        {selectableDevelopmentEnvironments.map((environment) => (
                          <option key={environment.environmentId} value={environment.environmentId}>
                            {environment.workspaceName} · {String(environment.cpuCount)}C ·{" "}
                            {String(environment.memoryMiB / 1024)}G · {environment.state}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="product-choice-card">
                    <input
                      checked={exclusiveChoice === "new"}
                      onChange={() => setExclusiveChoice("new")}
                      type="radio"
                    />
                    <span>
                      <strong>申请新环境</strong>
                      <small>为所选 Workspace 创建一台独占 KVM</small>
                    </span>
                  </label>
                  {exclusiveChoice === "new" ? (
                    <div
                      className="product-resource-profiles"
                      role="radiogroup"
                      aria-label="运行环境规格"
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
                            <strong>{profile.label}</strong>
                            {profile.recommended ? <em>推荐</em> : null}
                          </span>
                          <b>{String(profile.cpuCount)} vCPU</b>
                          <small>{String(profile.memoryMiB / 1024)} GiB 内存</small>
                          <small>{String(profile.systemDiskGiB)} GiB 系统盘</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </fieldset>
              ) : null}

              {executionMode === "elastic" || exclusiveChoice === "new" ? (
                <fieldset className="product-workspace-choice">
                  <legend>Workspace</legend>
                  {workspaces.length > 0 ? (
                    <label className="product-choice-card">
                      <input
                        checked={workspaceChoice === "existing"}
                        onChange={() => setWorkspaceChoice("existing")}
                        type="radio"
                      />
                      <span>
                        <strong>选择已有 Workspace</strong>
                        <small>继续使用已有文件、依赖和 Git 状态</small>
                      </span>
                    </label>
                  ) : null}
                  {workspaceChoice === "existing" && workspaces.length > 0 ? (
                    <div className="product-workspace-selection">
                      <label>
                        <span>目录</span>
                        <select
                          onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                          value={selectedWorkspaceId}
                        >
                          {workspaces.map((workspace) => (
                            <option key={workspace.workspaceId} value={workspace.workspaceId}>
                              {workspace.name}（{String(workspace.sessionCount)} 个对话）
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedWorkspace === undefined ? null : (
                        <div className="product-workspace-delete">
                          <button
                            className="product-danger-button"
                            disabled={!canMutate || operation !== null}
                            onClick={() => void deleteWorkspace(selectedWorkspace)}
                            type="button"
                          >
                            {operation === "deleting-workspace" ? "删除中…" : "删除 Workspace"}
                          </button>
                          {selectedWorkspace.sessionCount > 0 ? (
                            <small>
                              删除只移除文件；{String(selectedWorkspace.sessionCount)}{" "}
                              个对话会保留并等待重新绑定。
                            </small>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <label className="product-choice-card">
                    <input
                      checked={workspaceChoice === "new"}
                      onChange={() => setWorkspaceChoice("new")}
                      type="radio"
                    />
                    <span>
                      <strong>创建新 Workspace</strong>
                      <small>创建一个新的空 /workspace 目录</small>
                    </span>
                  </label>
                  {workspaceChoice === "new" ? (
                    <label>
                      <span>Workspace 名称</span>
                      <input
                        maxLength={256}
                        onChange={(event) => setNewWorkspaceName(event.target.value)}
                        placeholder="例如：order-service"
                        required
                        value={newWorkspaceName}
                      />
                    </label>
                  ) : null}
                </fieldset>
              ) : null}
              <footer>
                <button
                  onClick={() => {
                    setWorkspacePanelOpen(false);
                    setPendingInitialPrompt(null);
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="product-primary-button"
                  disabled={
                    operation !== null ||
                    (executionMode === "exclusive" &&
                      exclusiveChoice === "existing" &&
                      selectedDevelopmentEnvironmentId === "")
                  }
                  type="submit"
                >
                  {operation === "creating" ? "创建中…" : "创建对话"}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

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
                  <h2>为对话选择新的 Workspace</h2>
                  <p>对话历史仍然完整；原 Workspace 文件已被删除。重新绑定后即可继续。</p>
                </div>
                <button onClick={() => setWorkspaceRebindOpen(false)} type="button">
                  ×
                </button>
              </header>
              <fieldset className="product-workspace-choice">
                <legend>新的 Workspace</legend>
                {workspaces.length > 0 ? (
                  <label className="product-choice-card">
                    <input
                      checked={rebindWorkspaceChoice === "existing"}
                      onChange={() => setRebindWorkspaceChoice("existing")}
                      type="radio"
                    />
                    <span>
                      <strong>选择已有 Workspace</strong>
                      <small>使用其中当前的文件状态继续这段对话</small>
                    </span>
                  </label>
                ) : null}
                {rebindWorkspaceChoice === "existing" && workspaces.length > 0 ? (
                  <select
                    onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                    value={selectedWorkspaceId}
                  >
                    {workspaces.map((workspace) => (
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
                    <strong>创建新 Workspace</strong>
                    <small>创建空目录并将这段对话绑定过去</small>
                  </span>
                </label>
                {rebindWorkspaceChoice === "new" ? (
                  <input
                    maxLength={256}
                    onChange={(event) => setRebindWorkspaceName(event.target.value)}
                    placeholder="例如：recovered-order-service"
                    value={rebindWorkspaceName}
                  />
                ) : null}
              </fieldset>
              <footer>
                <button onClick={() => setWorkspaceRebindOpen(false)} type="button">
                  取消
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
                  {operation === "rebinding-workspace" ? "绑定中…" : "绑定并继续"}
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
                  <h2>通过 SSH 连接独享环境</h2>
                  <p>
                    凭据只能使用一次，并在 {new Date(sshTicket.expiresAt).toLocaleTimeString()}{" "}
                    失效。
                  </p>
                </div>
                <button onClick={() => setSshTicket(null)} type="button">
                  ×
                </button>
              </header>
              <label>
                <span>命令</span>
                <code>{sshTicket.command}</code>
              </label>
              <label>
                <span>一次性密码</span>
                <code>{sshTicket.password}</code>
              </label>
              <p className="product-resource-boundary-note">
                SSH 在可信网关完成用户鉴权，再接入 Cube 的 PTY；沙箱不会暴露 22 端口、平台凭据或
                Cube 控制令牌。
              </p>
              <footer>
                <button
                  onClick={() => void navigator.clipboard.writeText(sshTicket.command)}
                  type="button"
                >
                  复制命令
                </button>
                <button
                  className="product-primary-button"
                  onClick={() => void navigator.clipboard.writeText(sshTicket.password)}
                  type="button"
                >
                  复制密码
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
                  <h2>从此对话开始</h2>
                  <p>复制这里之前的 Pi 对话上下文并创建一条新分支。</p>
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
                <span>分支名称（可选）</span>
                <input
                  autoFocus
                  maxLength={256}
                  onChange={(event) => setForkTitle(event.target.value)}
                  placeholder="例如：改用事件驱动方案"
                  value={forkTitle}
                />
              </label>
              <p className="product-fork-note">
                Workspace 继续使用当前目录；此操作只分叉对话上下文，不会把文件回退到历史状态。
                分支首次调用工具时会取得这个 Workspace
                的执行权；其他分支持久沙箱里的后台进程不会跨分支保留。
              </p>
              <footer>
                <button
                  onClick={() => {
                    setForkTarget(null);
                    setForkTitle("");
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="product-primary-button"
                  disabled={operation !== null}
                  type="submit"
                >
                  {operation === "forking" ? "创建中…" : "创建分支"}
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
            <span>这个对话的 Workspace 已被删除，但对话历史仍可查看。</span>
            <button
              disabled={!canMutate}
              onClick={() => {
                setSelectedWorkspaceId(workspaces[0]?.workspaceId ?? "");
                setRebindWorkspaceChoice(workspaces.length === 0 ? "new" : "existing");
                setRebindWorkspaceName("");
                setWorkspaceRebindOpen(true);
              }}
              type="button"
            >
              选择新的 Workspace
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
              <div className="product-welcome">
                <div className="product-logo product-logo-large">A</div>
                <h1>你好，{identity.displayName}</h1>
                <p>今天想让 PiCloud 帮你完成什么？</p>
                <div className="product-examples">
                  {EXAMPLE_PROMPTS.map((example) => (
                    <button key={example} onClick={() => setPrompt(example)} type="button">
                      {example}
                      <span>→</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="product-transcript">
                {state.inheritedMessages.length === 0 ? null : (
                  <section className="product-inherited-context">
                    <header>
                      <strong>继承的对话上下文</strong>
                      <span>以下内容来自 Subagent 创建时的父会话快照</span>
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
                              <Markdown>{message.text}</Markdown>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="product-inherited-divider">
                      <span>Subagent 独立执行从这里开始</span>
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
              回到最新 ↓
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
            <div className="product-delegated-readonly">
              这是一次 Subagent 执行记录。后续消息请回到父会话发送。
            </div>
          )}
          <div className="product-composer">
            <textarea
              aria-label="发送消息"
              disabled={!canMutate || !canQueue}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitTurn();
                }
              }}
              placeholder={currentTurn ? "继续输入，消息会在当前任务后执行" : "给 PiCloud 发送消息"}
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
                  title="将这条消息注入当前运行中的 Agent Loop"
                  type="button"
                >
                  引导
                </button>
                <button
                  className="product-stop-button"
                  onClick={() => void cancelTurn()}
                  title="停止"
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
                title="发送"
                type="button"
              >
                ↑
              </button>
            )}
          </div>
          {steerNotice === null ? null : (
            <small className="product-steer-notice">{steerNotice}</small>
          )}
          <small>Agent 可能会出错，请检查重要的代码修改和测试结果。</small>
        </footer>
      </main>
    </div>
  );
}
