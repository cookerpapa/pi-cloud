import { ConversationTimeline, type TimelineControl } from "./ConversationTimeline.tsx";
import { useConversationCommands } from "./useConversationCommands.ts";
import {
  parseComposerCommand,
  composerCommandSuggestions,
  compactionPending,
} from "./composer-commands.ts";
import { ConversationUsage, CompactStatus } from "./ConversationUsage.tsx";
import { inputReturnRecovery, type InputReturnRecovery } from "./returned-inputs.ts";
import { InheritedContext } from "./InheritedContext.tsx";
import { useComposerUploads } from "./useComposerUploads.ts";
import { ComposerUploadCards } from "./UploadCards.tsx";
import { ComposerSubmission } from "./composer-submission.ts";
import { useComposerEnterMode } from "./useComposerEnterMode.tsx";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
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
  ExecutionMode,
  ModelCatalogEntryResource,
  ModelCatalogResource,
  SessionModelSelection,
  SessionModelResource,
  SshAccessTicketResource,
  TenantIdentityResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { DEFAULT_EXCLUSIVE_WORKING_DIRECTORY } from "@pi-cloud/protocol";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "./api.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { AuthScreen } from "./AuthScreen.tsx";
import { ConversationTreeNavigator } from "./ConversationTreeNavigator.tsx";
import { copyMessageText } from "./MessageCopyButton.tsx";
import { ConversationTurn } from "./ConversationTurn.tsx";
import { PendingInputQueue } from "./PendingInputQueue.tsx";
import { WorkspaceRebindDialog } from "./WorkspaceRebindDialog.tsx";

import {
  ModelSettingsMenu,
  defaultNewConversationSettings,
  settingsFromSessionModel,
} from "./ModelSettingsMenu.tsx";
import { activeTurn, createInitialSessionView, sessionViewReducer } from "./session-view.ts";
import { streamSessionEvents } from "./sse.ts";
import { ToolProgressStore } from "./tool-progress-store.ts";
import { RunObservationStore } from "./run-observation-store.ts";
import { errorMessage } from "./ui-errors.ts";
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";
import { useResizablePanel } from "./use-resizable-panel.ts";
import { useI18n, type Translate, type UiLanguage } from "./i18n.tsx";
import { identityDestination, type WebConfiguration } from "./web-configuration.ts";

const AdminPage = lazy(async () => ({
  default: (await import("./AdminPage.tsx")).AdminPage,
}));
const CodeHostConnectionsModal = lazy(async () => ({
  default: (await import("./CodeHostConnectionsModal.tsx")).CodeHostConnectionsModal,
}));
const ResourceManagementPage = lazy(async () => ({
  default: (await import("./ResourceManagementPage.tsx")).ResourceManagementPage,
}));
const WorkspaceDirectoryPicker = lazy(async () => ({
  default: (await import("./WorkspaceDirectoryPicker.tsx")).WorkspaceDirectoryPicker,
}));

type AuthPhase = "checking" | "anonymous" | "authenticated" | "unavailable";
const RECONNECT_DISPLAY_GRACE_MS = 1_000;

type PresentedConnectionPhase = "offline" | "connecting" | "live" | "reconnecting" | "failed";

export function connectionPhaseDisplayDelayMs(
  previous: PresentedConnectionPhase,
  next: PresentedConnectionPhase,
): number {
  return previous === "live" && next === "reconnecting" ? RECONNECT_DISPLAY_GRACE_MS : 0;
}

function usePresentedConnectionPhase(phase: PresentedConnectionPhase): PresentedConnectionPhase {
  const [presented, setPresented] = useState(phase);
  const presentedRef = useRef(phase);
  useEffect(() => {
    const commit = (next: PresentedConnectionPhase): void => {
      presentedRef.current = next;
      setPresented(next);
    };
    const delayMs = connectionPhaseDisplayDelayMs(presentedRef.current, phase);
    if (delayMs > 0) {
      const timer = setTimeout(() => commit(phase), delayMs);
      return () => clearTimeout(timer);
    }
    commit(phase);
  }, [phase]);
  return presented;
}

function conversationTitle(prompt: string, fallback: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact || fallback;
}

function modelKey(model: Pick<ModelCatalogEntryResource, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}

function modelSettingsKey(model: SessionModelSelection): string {
  return `${modelKey(model)}:${model.thinkingLevel}:${model.fastMode ? "fast" : "standard"}`;
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
  return mode === "branch" ? t("chat.context.inherited") : t("chat.context.fresh");
}

function delegatedSandboxLabel(
  mode: DelegatedSessionSummaryResource["sandboxMode"],
  t: Translate,
): string {
  if (mode === "shared") return t("chat.sandbox.shared");
  if (mode === "ephemeral") return t("chat.sandbox.ephemeral");
  return t("chat.sandbox.none");
}

function delegatedStateLabel(
  state: DelegatedSessionSummaryResource["state"],
  t: Translate,
): string {
  if (state === "preparing") return t("run.phase.preparing");
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

export default function ChatApp({ configuration }: { configuration: WebConfiguration }) {
  const { language, t } = useI18n();
  const api = useMemo(() => new PiCloudApi(), []);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [state, setState] = useState(createInitialSessionView);
  const renderedState = useRef(state);
  renderedState.current = state;
  const commands = useConversationCommands(
    api,
    authPhase === "authenticated" ? state.session?.sessionId : undefined,
  );
  const commandEvents = useRef(commands.notify);
  commandEvents.current = commands.notify;
  const inputRevision = useRef(0);
  const [queueRefreshGeneration, setQueueRefreshGeneration] = useState(0);
  const [streamQueue, setStreamQueue] = useState<
    import("@pi-cloud/protocol").InputQueueResource | null
  >(null);
  const timelineControl = useRef<TimelineControl | null>(null);
  const [streamSessionId, setStreamSessionId] = useState<string | null>(null);
  const currentStreamSession = useRef(streamSessionId);
  currentStreamSession.current = streamSessionId;
  const presentedConnectionPhase = usePresentedConnectionPhase(state.connection.phase);
  const [conversations, setConversations] = useState<readonly ConversationSummaryResource[]>([]);
  const conversationListRequest = useRef(0);
  const [conversationCursor, setConversationCursor] = useState<string>();
  const [conversationPageLoading, setConversationPageLoading] = useState(false);
  const conversationPageRequest = useRef(false);
  const [delegatedSessions, setDelegatedSessions] = useState<
    readonly DelegatedSessionSummaryResource[]
  >([]);
  const [selectedDelegatedSession, setSelectedDelegatedSession] =
    useState<DelegatedSessionSummaryResource | null>(null);
  const [conversationTree, setConversationTree] = useState<ConversationTreeResource | null>(null);
  const [treeView, setTreeView] = useState<ConversationTreeView>("focus");
  const currentTreeView = useRef(treeView);
  currentTreeView.current = treeView;
  const treeRequest = useRef(0);
  const treeNavigation = useRef<{ branchSessionId?: string; beforeEntryId?: string }>({});
  const [treeLoading, setTreeLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummaryResource[]>([]);
  const [developmentEnvironments, setDevelopmentEnvironments] = useState<
    readonly DevelopmentEnvironmentResource[]
  >([]);
  const [developmentProfiles, setDevelopmentProfiles] = useState<
    DevelopmentEnvironmentListResource["profiles"]
  >([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResource | null>(null);
  const [newConversationModel, setNewConversationModel] = useState<SessionModelSelection | null>(
    null,
  );
  const [sessionModel, setSessionModel] = useState<SessionModelResource | null>(null);
  const [conversationLoading, setConversationLoading] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false),
    [commandIndex, setCommandIndex] = useState(0);
  const commandSuggestions = commandMenuDismissed ? [] : composerCommandSuggestions(prompt);
  const commandMenuOpen = commandSuggestions.length > 0;
  const selectedCommand = commandSuggestions[Math.min(commandIndex, commandSuggestions.length - 1)];
  const composerCommand = parseComposerCommand(selectedCommand ? "/" + selectedCommand : prompt);
  const draftRevision = useRef(0);
  const restoredInputs = useRef(new Map<string, InputReturnRecovery>());
  const returnRecovery = state.session
    ? (restoredInputs.current.get(state.session.sessionId) ?? inputReturnRecovery())
    : inputReturnRecovery();
  if (state.session) restoredInputs.current.set(state.session.sessionId, returnRecovery);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const uploads = useComposerUploads(
    api,
    state.session?.sessionId,
    state.session
      ? `${state.session.sessionId}:${state.session.workspaceId}:${state.session.workingDirectory}`
      : "",
  );
  const [operation, setOperation] = useState<
    | "creating"
    | "submitting"
    | "cancelling"
    | "steering"
    | "forking"
    | "pruning"
    | "deleting-conversation"
    | "managing-environment"
    | "downloading"
    | "switching-model"
    | null
  >(null);
  const composerPreference = useComposerEnterMode(identity);
  const composerSubmission = useRef(new ComposerSubmission());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [codeHostConnectionsOpen, setCodeHostConnectionsOpen] = useState(false);
  const initialResourceTab =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("resource") === "source-control"
      ? "source-control"
      : "workspaces";
  const [resourcePageOpen, setResourcePageOpen] = useState(initialResourceTab === "source-control");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [workspaceRebindOpen, setWorkspaceRebindOpen] = useState(false);
  const [sshTicket, setSshTicket] = useState<SshAccessTicketResource | null>(null);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState<"existing" | "new">("new");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode | null>(null);
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
  const chatScrollerRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const deepLinkHandledRef = useRef(false);
  const currentTurn = activeTurn(state);
  const composerModelSelection =
    state.session === null
      ? newConversationModel
      : sessionModel === null
        ? null
        : settingsFromSessionModel(sessionModel);
  const currentDevelopmentEnvironment = developmentEnvironments.find(
    (environment) =>
      state.session?.executionMode === "development_environment" &&
      state.session.developmentEnvironmentId !== undefined &&
      environment.environmentId === state.session.developmentEnvironmentId &&
      ["requested", "provisioning", "running", "paused", "releasing", "failed", "unknown"].includes(
        environment.state,
      ),
  );
  const selectableDevelopmentEnvironments = developmentEnvironments.filter((environment) =>
    ["running", "paused"].includes(environment.state),
  );
  const elasticWorkspaces = workspaces;
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
      state.sessionState === "cancelling" ||
      // A failed snapshot can outlive confirmed exit/seal recovery. The API,
      // not this cached view, decides whether the next message is admissible.
      state.sessionState === "failed");
  const hasComposerDraft = Boolean(prompt.trim() || uploads.items.length);
  const activeCompact =
    commands.compact && compactionPending(commands.compact.state) ? commands.compact : null;
  const coldCompactActive =
    activeCompact?.initialOperation === true ||
    (currentTurn?.operation?.kind === "compact" &&
      ["queued", "running", "cancelling"].includes(currentTurn.status));
  const commandAllowed =
    composerCommand !== undefined &&
    state.session !== null &&
    (composerCommand.kind !== "compact" || (canMutate && selectedDelegatedSession === null));
  const canSendComposer = composerCommand
    ? commandAllowed
    : canMutate && canQueue && !coldCompactActive;

  const composerAction =
    currentTurn?.status === "running" || activeCompact !== null || coldCompactActive
      ? hasComposerDraft
        ? composerPreference.enterMode
        : "stop"
      : "send";
  const composerActionLabel = t(
    composerCommand
      ? "commands.execute"
      : composerAction === "stop"
        ? "chat.stop"
        : composerAction === "steer"
          ? "chat.steer"
          : composerAction === "follow_up"
            ? "composer.followUp"
            : "chat.send",
  );
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
    if (action.type === "turn.accepted" || action.type === "conversation.loaded")
      setQueueRefreshGeneration((value) => value + 1);
    if (
      action.type === "turn.accepted" ||
      action.type === "session.created" ||
      (action.type === "conversation.loaded" && !action.preserveInputRevision)
    )
      inputRevision.current++;
    if (action.type === "conversation.loaded")
      setStreamSessionId(action.conversation.session.sessionId);
    setState((current) => sessionViewReducer(current, action));
  }, []);

  const focusComposer = useCallback((): void => {
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (composer === null || composer.disabled) return;
      if (document.activeElement === composer) return;
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
    const request = ++conversationListRequest.current;
    try {
      const listed = await api.listConversations();
      if (request !== conversationListRequest.current) return;
      setConversations(listed.conversations);
      setDelegatedSessions(listed.delegatedSessions);
      setConversationCursor(listed.nextCursor);
    } catch (error) {
      if (request === conversationListRequest.current) throw error;
    }
  }, [api]);

  const loadMoreConversations = useCallback(async (): Promise<void> => {
    if (!conversationCursor || conversationPageRequest.current) return;
    const generation = conversationListRequest.current;
    conversationPageRequest.current = true;
    setConversationPageLoading(true);
    try {
      const page = await api.listConversations(conversationCursor);
      if (generation !== conversationListRequest.current) return;
      setConversations((current) => [
        ...new Map([...current, ...page.conversations].map((row) => [row.sessionId, row])).values(),
      ]);
      setDelegatedSessions((current) => [
        ...new Map(
          [...current, ...page.delegatedSessions].map((row) => [row.sessionId, row]),
        ).values(),
      ]);
      setConversationCursor(page.nextCursor);
    } catch (error) {
      if (generation === conversationListRequest.current)
        update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      conversationPageRequest.current = false;
      setConversationPageLoading(false);
    }
  }, [api, conversationCursor, t, update]);

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

  const refreshBindingResources = useCallback(async (): Promise<void> => {
    await Promise.all([refreshWorkspaces(), refreshDevelopmentEnvironments()]);
  }, [refreshWorkspaces, refreshDevelopmentEnvironments]);

  const refreshModelCatalog = useCallback(async (): Promise<void> => {
    const catalog = await api.getModelCatalog();
    setModelCatalog(catalog);
    setNewConversationModel(defaultNewConversationSettings(catalog));
  }, [api]);

  const refreshConversationTree = useCallback(
    async (sessionId: string, view: ConversationTreeView): Promise<void> => {
      if (currentStreamSession.current !== sessionId || currentTreeView.current !== view) return;
      const request = ++treeRequest.current;
      const current = () =>
        request === treeRequest.current &&
        currentStreamSession.current === sessionId &&
        currentTreeView.current === view;
      setTreeLoading(true);
      try {
        const tree = await api.getConversationTree(sessionId, view, treeNavigation.current);
        if (current()) setConversationTree(tree);
      } catch (error) {
        if (current()) throw error;
      } finally {
        if (current()) setTreeLoading(false);
      }
    },
    [api],
  );

  const loadConversation = useCallback(
    async (sessionId: string) => {
      const [conversation, model] = await Promise.all([
        api.getConversation(sessionId),
        api.getSessionModel(sessionId),
      ]);
      setSessionModel(model);
      return { conversation };
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
        setAuthPhase("unavailable");
        update({ type: "api.error", message: errorMessage(error, t) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, t, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity === null) return;
    const destination = identityDestination(
      configuration,
      identity.platformAdministrator,
      window.location.origin,
    );
    if (destination !== null) window.location.replace(destination);
  }, [authPhase, identity, configuration]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    let cancelled = false;
    void refreshConversations().catch((error: unknown) => {
      if (!cancelled) update({ type: "api.error", message: errorMessage(error, t) });
    });
    return () => {
      cancelled = true;
      conversationListRequest.current++;
    };
  }, [
    authPhase,
    identity?.platformAdministrator,
    identity?.tenantId,
    refreshConversations,
    t,
    update,
  ]);

  useEffect(() => {
    if (authPhase !== "authenticated" || deepLinkHandledRef.current || conversations.length === 0) {
      return;
    }
    const target = new URLSearchParams(window.location.search).get("session");
    if (target === null) {
      deepLinkHandledRef.current = true;
      return;
    }
    const conversation = conversations.find((candidate) => candidate.sessionId === target);
    if (conversation === undefined) return;
    deepLinkHandledRef.current = true;
    void openConversationSession(conversation.sessionId, undefined, false, null);
  }, [authPhase, conversations]);

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
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshModelCatalog().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error, t) });
    });
  }, [
    authPhase,
    identity?.platformAdministrator,
    identity?.tenantId,
    refreshModelCatalog,
    t,
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
      treeRequest.current++;
      setConversationTree(null);
      setTreeLoading(false);
      return;
    }
    let cancelled = false;
    treeNavigation.current = {};
    void refreshConversationTree(sessionId, treeView).catch((error: unknown) => {
      if (!cancelled) update({ type: "api.error", message: errorMessage(error, t) });
    });
    return () => {
      cancelled = true;
      treeRequest.current++;
    };
  }, [refreshConversationTree, authPhase, state.session?.sessionId, treeView, update]);

  const streamPresentation = useRef({ treeView, t });
  const toolProgress = useMemo(() => new ToolProgressStore(), []);
  const runObservations = useMemo(() => new RunObservationStore(), []);
  streamPresentation.current = { treeView, t };
  useEffect(() => {
    const sessionId = streamSessionId;
    if (sessionId === null || authPhase !== "authenticated") return;
    const controller = new AbortController();
    let snapshotInputRevision = inputRevision.current;
    const discoveredChildren = new Set<string>();
    let childRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshChildren = () => {
      if (childRefreshTimer !== undefined) return;
      childRefreshTimer = setTimeout(() => {
        childRefreshTimer = undefined;
        if (!controller.signal.aborted)
          void refreshConversationTree(sessionId, streamPresentation.current.treeView).catch(() =>
            discoveredChildren.clear(),
          );
      }, 100);
    };
    void streamSessionEvents({
      sessionId,
      signal: controller.signal,
      onSnapshot(snapshot) {
        if (controller.signal.aborted || currentStreamSession.current !== sessionId) return;
        commandEvents.current("snapshot");
        toolProgress.reset();
        runObservations.reset();
        // Reject a snapshot which raced with an accepted local input. This is
        // request invalidation, not a persisted or server-supplied stream cursor.
        if (snapshotInputRevision !== inputRevision.current) {
          controller.abort();
          setReconnectGeneration((v) => v + 1);
          return;
        }
        update({
          type: "conversation.loaded",
          conversation: snapshot.conversation,
          preserveInputRevision: true,
        });
        setConversationLoading(null);
        if (
          snapshot.conversation.session.workspaceState === "missing" &&
          !snapshot.conversation.turns.some(
            (turn) =>
              turn.operation?.kind === "compact" &&
              ["queued", "running", "cancelling"].includes(turn.state),
          )
        ) {
          setWorkspaceRebindOpen(true);
        }
      },
      onEvent(event) {
        if (controller.signal.aborted || currentStreamSession.current !== sessionId) return;
        if (
          event.type === "tool.completed" &&
          renderedState.current.turns.some(
            (turn) =>
              turn.turnId === event.turnId &&
              turn.items.some(
                (item) =>
                  item.kind === "tool" &&
                  item.toolCallId === event.payload.toolCallId &&
                  ["subagent", "subagent_control", "subagent_supervisor", "workflow"].includes(
                    item.toolName,
                  ),
              ),
          )
        )
          refreshChildren();
        timelineControl.current?.event(event);
        update({ type: "stream.event", event });
        commandEvents.current(event.type);
        if (
          event.type === "turn.started" &&
          !renderedState.current.turns.some((turn) => turn.turnId === event.turnId && turn.runId)
        ) {
          void api
            .getConversation(sessionId)
            .then((conversation) => {
              const turn = conversation.turns.find((turn) => turn.turnId === event.turnId);
              if (turn && !controller.signal.aborted)
                update({ type: "turn.discovered", sessionId, turn });
            })
            .catch((error) => {
              if (!controller.signal.aborted)
                update({
                  type: "api.error",
                  message: errorMessage(error, streamPresentation.current.t),
                });
            });
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          setInspectorRefreshSignal((value) => value + 1);
          void refreshConversations().catch(() => undefined);
          void refreshConversationTree(sessionId, streamPresentation.current.treeView).catch(
            () => undefined,
          );
        }
      },
      onToolProgress(progress) {
        if (!controller.signal.aborted && currentStreamSession.current === sessionId) {
          toolProgress.receive(progress);
          runObservations.toolProgress(progress.turnId);
        }
      },
      onRunObservation(observation) {
        if (!controller.signal.aborted && currentStreamSession.current === sessionId) {
          runObservations.receive(observation);
          if (observation.type === "run.child_activity") {
            const key = `${observation.childSessionId}:${observation.state}`;
            if (!discoveredChildren.has(key)) {
              discoveredChildren.add(key);
              refreshChildren();
            }
          }
        }
      },
      onInputQueue(queue) {
        if (!controller.signal.aborted && currentStreamSession.current === sessionId)
          setStreamQueue(queue);
      },
      onStatus(status) {
        if (controller.signal.aborted) return;
        if (status.phase !== "live") toolProgress.reset();
        if (status.phase !== "live") runObservations.reset();
        if (status.phase !== "live") setStreamQueue(null);
        if (status.phase === "connecting" || status.phase === "reconnecting")
          snapshotInputRevision = inputRevision.current;
        // Read once after subscription is established, covering changes between
        // the initial HTTP snapshot and SSE opening. Later updates are pushed.
        if (status.phase === "live") {
          setQueueRefreshGeneration((value) => value + 1);
          refreshChildren();
        }
        update({ type: "stream.status", status });
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        setConversationLoading(null);
        update({
          type: "api.error",
          message: streamPresentation.current.t("chat.streamDisconnected"),
        });
      }
    });
    return () => {
      controller.abort();
      if (childRefreshTimer !== undefined) clearTimeout(childRefreshTimer);
      toolProgress.reset();
      runObservations.reset();
    };
  }, [
    api,
    authPhase,
    reconnectGeneration,
    refreshConversations,
    refreshConversationTree,
    streamSessionId,
    toolProgress,
    update,
  ]);

  function resetConversation(preserveDraft = false): void {
    if (!preserveDraft) {
      uploads.clear();
      composerSubmission.current.reset();
    }
    currentStreamSession.current = null;
    setStreamSessionId(null);
    setState(createInitialSessionView());
    setSessionModel(null);
    if (!preserveDraft) setPrompt("");
    setInspectorOpen(false);
    setSidebarOpen(false);
    setConversationTree(null);
    setSelectedDelegatedSession(null);
    setPendingTreeJump(null);
    timelineControl.current?.latest();
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch (error) {
      if (!(error instanceof PiCloudApiError && error.status === 401)) throw error;
    }
    // Discard every account-scoped cache and outstanding response together.
    // A partial in-place reset can leak the previous account into the next login.
    window.location.replace("/");
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
      if (currentStreamSession.current !== sessionId) {
        setConversationTree(null);
        uploads.clear();
      }
      currentStreamSession.current = sessionId;
      setStreamSessionId(sessionId);
      if (streamSessionId === sessionId) setReconnectGeneration((value) => value + 1);
      setSelectedDelegatedSession(delegatedSession);
      setSessionModel(null);
      if (jumpTarget !== undefined) setPendingTreeJump(jumpTarget);
      setSidebarOpen(false);
      const model = await api.getSessionModel(sessionId);
      if (currentStreamSession.current === sessionId) setSessionModel(model);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
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
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
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
    resetConversation(initialPrompt !== null);
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
    if (modelCatalog !== null && state.session !== null) {
      setNewConversationModel(defaultNewConversationSettings(modelCatalog));
    }
    setWorkspacePanelOpen(true);
  }

  async function createConversation(): Promise<void> {
    const submittedRevision = draftRevision.current;
    const title = newConversationTitle.trim();
    if (title.length === 0 || operation !== null || newConversationModel === null) return;
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      let projectId: string;
      let workspaceId: string;
      if (executionMode === null) return;
      const freshDevelopmentEnvironments =
        executionMode === "development_environment"
          ? (await api.listDevelopmentEnvironments()).environments
          : developmentEnvironments;
      if (executionMode === "development_environment") {
        setDevelopmentEnvironments(freshDevelopmentEnvironments);
      }
      const existingEnvironment =
        executionMode === "development_environment"
          ? freshDevelopmentEnvironments.find(
              (environment) =>
                environment.environmentId === selectedDevelopmentEnvironmentId &&
                ["running", "paused"].includes(environment.state),
            )
          : undefined;
      if (executionMode === "development_environment" && existingEnvironment === undefined) {
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
        const created = await api.createProject(name, { kind: "empty" });
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
        executionMode,
        sandboxProfileKey,
        executionMode === "development_environment" ? workingDirectory : "/workspace",
        newConversationModel,
      );
      const loaded = await loadConversation(session.sessionId);
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
      });
      setWorkspacePanelOpen(false);
      await Promise.all([
        refreshConversations(),
        refreshWorkspaces(),
        refreshDevelopmentEnvironments(),
      ]);
      if (pendingInitialPrompt !== null) {
        const attached = await uploads.ready(session.sessionId);
        const accepted = await acceptComposerTurn(
          session.sessionId,
          pendingInitialPrompt,
          attached.map((file) => file.id),
        );
        if (accepted.kind === "run")
          update({
            type: "turn.accepted",
            accepted,
            prompt: pendingInitialPrompt,
            uploads: attached,
          });
        uploads.clear(attached.map((file) => file.id));
        setPrompt((current) => (draftRevision.current === submittedRevision ? "" : current));
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
      await api.deleteConversation(conversation.sessionId);
      if (state.session?.sessionId === conversation.sessionId) resetConversation();
      await Promise.all([refreshConversations(), refreshWorkspaces()]);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  async function refreshReboundConversation(sessionId: string): Promise<void> {
    const [conversation, model] = await Promise.all([
      api.getConversation(sessionId),
      api.getSessionModel(sessionId),
    ]);
    if (currentStreamSession.current !== sessionId) return;
    setSessionModel(model);
    update({ type: "conversation.loaded", conversation });
    setWorkspaceRebindOpen(false);
    await Promise.all([refreshConversations(), refreshBindingResources()]);
    focusComposer();
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

  async function switchCurrentModel(selection: SessionModelSelection): Promise<void> {
    const sessionId = state.session?.sessionId;
    if (
      sessionId === undefined ||
      selectedDelegatedSession !== null ||
      currentTurn !== undefined ||
      operation !== null ||
      (sessionModel !== null &&
        modelSettingsKey(settingsFromSessionModel(sessionModel)) === modelSettingsKey(selection))
    ) {
      return;
    }
    setOperation("switching-model");
    update({ type: "api.error.cleared" });
    try {
      setSessionModel(await api.updateSessionModel(sessionId, selection));
      commandEvents.current("snapshot");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function downloadConversation(): Promise<void> {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined || operation !== null) return;
    setOperation("downloading");
    update({ type: "api.error.cleared" });
    try {
      const link = document.createElement("a");
      link.href = api.conversationExportUrl(sessionId);
      link.download = "";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
    }
  }

  function acceptComposerTurn(sessionId: string, text: string, uploadIds: string[]) {
    return composerSubmission.current.send({ kind: "turn", sessionId, text, uploadIds }, (key) =>
      api.acceptTurn(sessionId, text, key, undefined, uploadIds),
    );
  }

  async function submitTurn(): Promise<void> {
    const submittedRevision = draftRevision.current;
    const text = prompt.trim();
    if ((!text && !uploads.items.length) || !canMutate || !canQueue || operation !== null) return;
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      let session = state.session;
      if (session === null) {
        setOperation(null);
        beginNewConversation(text);
        return;
      }
      if (session.executionMode === "development_environment") {
        const environmentId = session.developmentEnvironmentId;
        const environment = developmentEnvironments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment?.state === "paused") {
          const resumed = await api.developmentEnvironmentAction(
            environment.environmentId,
            "resume",
            newIdempotencyKey("environment"),
          );
          setDevelopmentEnvironments((current) =>
            current.map((candidate) =>
              candidate.environmentId === resumed.environmentId ? resumed : candidate,
            ),
          );
        }
      }
      const attached = await uploads.ready(session.sessionId);
      const accepted = await acceptComposerTurn(
        session.sessionId,
        text,
        attached.map((file) => file.id),
      );
      if (accepted.kind === "run")
        update({ type: "turn.accepted", accepted, prompt: text, uploads: attached });
      else setQueueRefreshGeneration((generation) => generation + 1);
      uploads.clear(attached.map((file) => file.id));
      timelineControl.current?.latest();
      setPrompt((current) => (draftRevision.current === submittedRevision ? "" : current));
      void refreshConversations().catch(() => undefined);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function cancelTurn(): Promise<void> {
    if (
      !canMutate ||
      selectedDelegatedSession !== null ||
      state.session === null ||
      (currentTurn?.status !== "running" && !activeCompact && !coldCompactActive) ||
      operation !== null
    )
      return;
    const targetTurnId = activeCompact?.initialOperation
      ? activeCompact.turnId
      : currentTurn?.turnId;
    if (!targetTurnId) return;
    setOperation("cancelling");
    try {
      await api.cancelTurn(state.session.sessionId, targetTurnId, newIdempotencyKey("cancel"));
      update({ type: "turn.cancellation.requested", turnId: targetTurnId });
      if (coldCompactActive) {
        // An unclaimed command settles directly in PG and has no native SSE tail.
        const sessionId = state.session.sessionId;
        const [conversation, compact] = await Promise.all([
          api.getConversation(sessionId),
          api.getCompaction(sessionId, targetTurnId),
        ]);
        if (renderedState.current.session?.sessionId === sessionId) {
          if (compact) commands.acceptedCompact(compact);
          update({ type: "conversation.loaded", conversation, preserveInputRevision: true });
        }
      }
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function steerTurn(): Promise<void> {
    const submittedRevision = draftRevision.current;
    const text = prompt.trim();
    if (
      state.session === null ||
      currentTurn?.status !== "running" ||
      (!text && !uploads.items.length) ||
      !canMutate ||
      !canQueue ||
      operation !== null
    ) {
      return;
    }
    setOperation("steering");
    update({ type: "api.error.cleared" });
    try {
      const attached = await uploads.ready(state.session.sessionId);
      const uploadIds = attached.map((file) => file.id);
      const sessionId = state.session.sessionId,
        targetTurnId = currentTurn.turnId;
      await composerSubmission.current.send(
        { kind: "steer", sessionId, targetTurnId, text, uploadIds },
        (key) => api.steerTurn(sessionId, targetTurnId, text, key, uploadIds),
      );
      setQueueRefreshGeneration((generation) => generation + 1);
      uploads.clear(attached.map((file) => file.id));
      setPrompt((current) => (draftRevision.current === submittedRevision ? "" : current));
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      setOperation(null);
      focusComposer();
    }
  }

  async function submitComposerCommand(text: string): Promise<void> {
    const command = parseComposerCommand(text);
    if (!command || operation !== null) return;
    const sessionId = state.session?.sessionId,
      submittedRevision = draftRevision.current;
    if (!sessionId) {
      update({ type: "api.error", message: t("commands.needSession") });
      return;
    }
    if (command.kind === "invalid") {
      update({ type: "api.error", message: t("commands.usageArguments") });
      return;
    }
    if (command.kind === "compact" && (!canMutate || selectedDelegatedSession !== null)) {
      update({ type: "api.error", message: t("commands.readOnly") });
      return;
    }
    setCommandMenuDismissed(true);
    update({ type: "api.error.cleared" });
    try {
      if (command.kind === "usage") {
        if (!(await commands.openUsage())) return;
      } else {
        setOperation("submitting");
        const accepted = await composerSubmission.current.send(
          { kind: "compact", sessionId, text: command.instructions, uploadIds: [] },
          (key) => api.compactConversation(sessionId, command.instructions, key),
        );
        if (renderedState.current.session?.sessionId !== sessionId) return;
        commands.acceptedCompact(accepted);
        update({ type: "compact.accepted", compact: accepted });
      }
      if (renderedState.current.session?.sessionId === sessionId)
        setPrompt((current) => (draftRevision.current === submittedRevision ? "" : current));
    } catch (error) {
      if (renderedState.current.session?.sessionId === sessionId)
        update({ type: "api.error", message: errorMessage(error, t) });
    } finally {
      if (command.kind === "compact") setOperation(null);
      focusComposer();
    }
  }

  function sendComposer(): void {
    if (!hasComposerDraft) return;
    if (composerCommand) {
      void submitComposerCommand(selectedCommand ? "/" + selectedCommand : prompt);
      return;
    }
    if (coldCompactActive) {
      update({ type: "api.error", message: t("commands.compactBusy") });
      return;
    }
    if (composerAction === "steer") void steerTurn();
    else void submitTurn();
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
                {delegated.contextMode === "branch" ? "↳" : "⋯"}
              </span>
              {t("chat.subagentTitle")}
            </strong>
            <small>
              {t("chat.subagentDepth", { depth: delegated.depth })} ·{" "}
              {delegatedContextLabel(delegated.contextMode, t)} ·{" "}
              {delegatedSandboxLabel(delegated.sandboxMode, t)} ·{" "}
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
  if (authPhase === "unavailable") {
    return (
      <main className="product-loading-page">
        <section className="product-auth-card product-identity-error" role="alert">
          <p>{state.apiError}</p>
          <button
            className="product-primary-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            {t("common.retry")}
          </button>
        </section>
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
  if (
    identityDestination(configuration, identity.platformAdministrator, window.location.origin) !==
    null
  ) {
    return <main className="product-loading-page" />;
  }
  if (identity.platformAdministrator) {
    return (
      <Suspense fallback={<main className="product-loading-page" />}>
        <AdminPage
          api={api}
          identity={identity}
          onLogout={logout}
          managementUrls={configuration.managementUrls}
        />
      </Suspense>
    );
  }
  if (resourcePageOpen) {
    return (
      <Suspense fallback={<main className="product-loading-page" />}>
        <ResourceManagementPage
          api={api}
          conversations={conversations}
          environments={developmentEnvironments}
          initialTab={initialResourceTab}
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
      </Suspense>
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
            <div className="product-sidebar-brand" aria-label="PiCloud">
              <span aria-hidden="true">π</span>
              <strong>PiCloud</strong>
            </div>
            <button
              className="product-new-chat"
              disabled={operation !== null}
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
            {conversationCursor ? (
              <button
                className="product-resource-nav"
                type="button"
                disabled={conversationPageLoading}
                onClick={() => void loadMoreConversations()}
              >
                {conversationPageLoading ? t("common.loading") : t("chat.loadMoreConversations")}
              </button>
            ) : null}
          </nav>
          <footer className="product-account">
            <AccountMenu
              label={identity.username ?? identity.displayName}
              onLogout={logout}
              placement="up"
              composer={composerPreference}
            />
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
        onPage={(branchSessionId, beforeEntryId) => {
          const sessionId = state.session?.sessionId;
          if (!sessionId) return;
          treeNavigation.current = { branchSessionId, ...(beforeEntryId ? { beforeEntryId } : {}) };
          void refreshConversationTree(sessionId, treeView).catch((error) =>
            update({ type: "api.error", message: errorMessage(error, t) }),
          );
        }}
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
                {t("chat.subagentTitle")} ·{" "}
                {delegatedContextLabel(selectedDelegatedSession.contextMode, t)} ·{" "}
                {delegatedSandboxLabel(selectedDelegatedSession.sandboxMode, t)} ·{" "}
                {t("chat.readOnly")}
              </span>
            )}
            {state.project ? (
              <span>
                {currentDevelopmentEnvironment === undefined
                  ? `/workspace · ${state.project.name} · ${t("chat.elastic")}`
                  : `${state.session?.workingDirectory ?? "/workspace"} · ${t("chat.exclusive", {
                      name: currentDevelopmentEnvironment.workspaceName,
                    })} · ${String(currentDevelopmentEnvironment.cpuCount)}C/${String(
                      currentDevelopmentEnvironment.memoryMiB / 1024,
                    )}G`}
                {state.session?.workspaceState === "missing"
                  ? ` · ${t("chat.workspaceDeleted")}`
                  : ""}
              </span>
            ) : null}
            {state.session ? (
              <span className={presentedConnectionPhase === "live" ? "online" : ""}>
                {presentedConnectionPhase === "live"
                  ? t("chat.connected")
                  : presentedConnectionPhase === "reconnecting"
                    ? t("chat.reconnecting")
                    : presentedConnectionPhase === "failed"
                      ? t("chat.connectionFailed")
                      : t("chat.connecting")}
              </span>
            ) : null}
            {state.session?.executionMode !== "development_environment" ||
            currentDevelopmentEnvironment?.state !== "running" ? null : (
              <div className="product-environment-controls">
                <button
                  disabled={currentTurn !== undefined || coldCompactActive || operation !== null}
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
              disabled={
                state.session === null ||
                state.session.workspaceState === "missing" ||
                selectedDelegatedSession !== null
              }
              onClick={() => setCodeHostConnectionsOpen(true)}
              type="button"
            >
              {t("codeHost.button")}
            </button>
            <button
              aria-label={t("chat.downloadConversation")}
              className="product-download-conversation"
              disabled={state.session === null || operation !== null}
              onClick={() => void downloadConversation()}
              title={t("chat.downloadConversationDescription")}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
              <span>
                {operation === "downloading"
                  ? t("chat.downloadingConversation")
                  : t("chat.downloadConversation")}
              </span>
            </button>
            <button
              className="product-history-search-toggle"
              type="button"
              disabled={state.session === null}
              aria-label={t("chat.searchHistory")}
              title={t("chat.searchHistory")}
              onClick={() => timelineControl.current?.search()}
            >
              ⌕
            </button>
            <button
              className="product-workspace-button"
              disabled={
                state.session === null ||
                state.session.workspaceState === "missing" ||
                selectedDelegatedSession !== null
              }
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

        {codeHostConnectionsOpen && state.session !== null ? (
          <Suspense fallback={null}>
            <CodeHostConnectionsModal
              api={api}
              onClose={() => setCodeHostConnectionsOpen(false)}
              workspaceId={state.session.workspaceId}
              workspaceName={state.project?.name ?? state.session.title}
            />
          </Suspense>
        ) : null}

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
                    checked={executionMode === "development_environment"}
                    onChange={() => {
                      setExecutionMode("development_environment");
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
                        <>
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
                        </>
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
                                    name: environment.workspaceName,
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
                    newConversationModel === null ||
                    executionMode === null ||
                    (executionMode === "development_environment" &&
                      selectedDevelopmentEnvironmentId === "") ||
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
                <Suspense fallback={null}>
                  <WorkspaceDirectoryPicker
                    api={api}
                    environmentId={environment.environmentId}
                    initialDirectory={workingDirectory}
                    onCancel={() => setDirectoryPickerOpen(false)}
                    onChoose={(directory) => {
                      setWorkingDirectory(directory);
                      setDirectoryPickerOpen(false);
                    }}
                    workspaceName={environment.workspaceName}
                  />
                </Suspense>
              );
            })()
          : null}

        {workspaceRebindOpen &&
        selectedDelegatedSession === null &&
        state.session?.workspaceState === "missing" ? (
          <WorkspaceRebindDialog
            key={state.session.sessionId}
            api={api}
            sessionId={state.session.sessionId}
            workspaces={elasticWorkspaces}
            environments={developmentEnvironments}
            canMutate={canMutate}
            onRefresh={refreshBindingResources}
            onBound={refreshReboundConversation}
            onClose={() => setWorkspaceRebindOpen(false)}
            onOpenResources={() => {
              setWorkspaceRebindOpen(false);
              setResourcePageOpen(true);
            }}
          />
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
                  onClick={() =>
                    void copyMessageText(sshTicket.oneLineCommand).catch((error: unknown) => {
                      update({ type: "api.error", message: errorMessage(error, t) });
                    })
                  }
                  type="button"
                >
                  {t("chat.ssh.copyCommand")}
                </button>
                <button
                  className="product-primary-button"
                  onClick={() =>
                    void copyMessageText(sshTicket.password).catch((error: unknown) => {
                      update({ type: "api.error", message: errorMessage(error, t) });
                    })
                  }
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
              disabled={!canMutate || selectedDelegatedSession !== null}
              onClick={() => {
                setWorkspaceRebindOpen(true);
              }}
              type="button"
            >
              {t("chat.chooseWorkspace")}
            </button>
          </div>
        ) : null}

        <div className={`product-content ${inspectorOpen ? "with-inspector" : ""}`}>
          <ConversationTimeline
            api={api}
            live={state}
            scrollerRef={chatScrollerRef}
            controlRef={timelineControl}
            jump={pendingTreeJump}
            onJumpSettled={() => setPendingTreeJump(null)}
            inherited={
              state.inheritedMessages.length ||
              state.inheritedContextSummary ||
              state.inheritedMessagesTruncated ? (
                <InheritedContext
                  messages={state.inheritedMessages}
                  summary={state.inheritedContextSummary}
                  truncated={state.inheritedMessagesTruncated === true}
                />
              ) : undefined
            }
            renderRow={(row) => {
              const turn = row.turn;
              const target = forkTargets.get(turn.turnId);
              return (
                <ConversationTurn
                  api={api}
                  {...(commands.compact?.runId === turn.runId
                    ? { compaction: commands.compact }
                    : {})}
                  progressStore={toolProgress}
                  observationStore={runObservations}
                  delegatedChildren={(conversationTree?.delegatedSessions ?? []).filter(
                    (child) =>
                      child.parentTurnId === turn.turnId &&
                      child.parentSessionId === state.session?.sessionId,
                  )}
                  onOpenChild={(child) =>
                    void openConversationSession(child.sessionId, undefined, false, child)
                  }
                  connected={state.connection.phase === "live"}
                  canFork={
                    canMutate &&
                    selectedDelegatedSession === null &&
                    operation === null &&
                    currentTurn === undefined &&
                    target !== undefined
                  }
                  canPrune={
                    canMutate &&
                    selectedDelegatedSession === null &&
                    operation === null &&
                    currentTurn === undefined &&
                    target !== undefined &&
                    target.sourceSessionId === state.session?.sessionId
                  }
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
                  fragment={row.fragment}
                />
              );
            }}
          />
          {inspectorOpen ? (
            <WorkspaceInspector
              api={api}
              onClose={() => setInspectorOpen(false)}
              onError={(message) => update({ type: "api.error", message })}
              refreshSignal={inspectorRefreshSignal}
              sessionId={state.session?.sessionId ?? null}
              workspaceId={state.project?.workspaceId ?? null}
              workspaceName={state.project?.name ?? null}
              developmentEnvironmentId={state.session?.developmentEnvironmentId ?? null}
              workingDirectory={state.session?.workingDirectory ?? "/workspace"}
            />
          ) : null}
        </div>

        <footer className="product-composer-area">
          {commands.usageOpen ? (
            <ConversationUsage
              value={commands.usage}
              loading={commands.usageLoading}
              error={commands.usageError}
              onRefresh={() => void commands.refreshUsage()}
              onClose={() => commands.closeUsage()}
            />
          ) : null}
          {activeCompact &&
          !state.turns.some(
            (turn) =>
              turn.runId === activeCompact.runId &&
              (turn.status !== "queued" || turn.operation?.kind === "compact"),
          ) ? (
            <CompactStatus state={activeCompact.state} />
          ) : null}
          <div className="product-composer-shell">
            {authPhase === "authenticated" &&
            state.session !== null &&
            selectedDelegatedSession === null ? (
              <PendingInputQueue
                key={state.session.sessionId}
                api={api}
                sessionId={state.session.sessionId}
                canMutate={canMutate}
                returnRecovery={returnRecovery}
                streamQueue={streamQueue}
                refreshSignal={String(queueRefreshGeneration)}
                onSnapshot={(queue) => update({ type: "queue.updated", queue })}
                onRestoreDraft={(text, attached, returnedKeys = []) => {
                  if (currentStreamSession.current !== state.session?.sessionId) return false;
                  if (!uploads.restore(attached)) return false;
                  composerSubmission.current.retireReturned(state.session.sessionId, returnedKeys);
                  draftRevision.current++;
                  setPrompt((current) => (current.trim() ? `${current}\n\n${text}` : text));
                  focusComposer();
                  return true;
                }}
              />
            ) : null}
            {selectedDelegatedSession === null ? null : (
              <div className="product-delegated-readonly">{t("chat.subagentReadOnly")}</div>
            )}
            <ComposerUploadCards
              items={uploads.items}
              disabled={operation !== null}
              remove={uploads.remove}
              retry={uploads.retry}
            />
            {uploads.error ? (
              <p role="alert" className="pending-input-error">
                {t("upload.limit")}
              </p>
            ) : null}
            <div
              className="product-composer"
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (canMutate && canQueue && operation === null)
                  uploads.add([...event.dataTransfer.files]);
              }}
            >
              <input
                type="file"
                multiple
                hidden
                ref={filePickerRef}
                aria-label={t("upload.add")}
                onChange={(event) => {
                  uploads.add([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="product-attach-button"
                title={t("upload.limit")}
                aria-label={t("upload.add")}
                disabled={!canMutate || !canQueue || operation !== null}
                onClick={() => filePickerRef.current?.click()}
              >
                ＋
              </button>
              {commandMenuOpen ? (
                <div
                  className="product-command-menu"
                  id="composer-command-menu"
                  role="listbox"
                  aria-label={t("commands.menu")}
                >
                  {commandSuggestions.map((command, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`composer-command-${command}`}
                      key={command}
                      aria-selected={command === selectedCommand}
                      onMouseEnter={() => setCommandIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void submitComposerCommand("/" + command)}
                    >
                      <code>/{command}</code>
                      <span>{t(command === "usage" ? "usage.title" : "commands.compact")}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-expanded={commandMenuOpen}
                aria-controls={commandMenuOpen ? "composer-command-menu" : undefined}
                aria-activedescendant={
                  commandMenuOpen ? `composer-command-${selectedCommand}` : undefined
                }
                aria-label={t("chat.sendLabel")}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.length && operation === null) {
                    event.preventDefault();
                    uploads.add(files);
                  }
                }}
                disabled={state.session === null && (!canMutate || !canQueue)}
                onChange={(event) => {
                  draftRevision.current++;
                  setPrompt(event.target.value);
                  setCommandMenuDismissed(false);
                  setCommandIndex(0);
                }}
                onKeyDown={(event) => {
                  if (
                    event.defaultPrevented ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  )
                    return;
                  if (commandMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                    event.preventDefault();
                    setCommandIndex(
                      (index) =>
                        (index + (event.key === "ArrowDown" ? 1 : -1) + commandSuggestions.length) %
                        commandSuggestions.length,
                    );
                    return;
                  }
                  if (commandMenuOpen && event.key === "Tab" && selectedCommand) {
                    event.preventDefault();
                    draftRevision.current++;
                    setPrompt("/" + selectedCommand + (selectedCommand === "compact" ? " " : ""));
                    setCommandMenuDismissed(true);
                    return;
                  }
                  if (event.key === "Escape" && commandMenuOpen) {
                    event.preventDefault();
                    setCommandMenuDismissed(true);
                    return;
                  }
                  if (event.key === "Escape" && commands.usageOpen) {
                    event.preventDefault();
                    commands.closeUsage();
                    return;
                  }
                  if (event.key === "Escape") {
                    // Scoped to the composer: menus, queue editors and dialogs own their Escape.
                    event.preventDefault();
                    if (!event.repeat) void cancelTurn();
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!event.repeat) sendComposer();
                  }
                }}
                placeholder={t("chat.promptPlaceholder")}
                ref={composerRef}
                rows={1}
                value={prompt}
              />
              {selectedDelegatedSession === null &&
              modelCatalog !== null &&
              composerModelSelection !== null ? (
                <ModelSettingsMenu
                  catalog={modelCatalog}
                  disabled={currentTurn !== undefined || operation !== null}
                  onApply={state.session === null ? setNewConversationModel : switchCurrentModel}
                  t={t}
                  value={composerModelSelection}
                />
              ) : null}
              <button
                className={
                  composerAction === "stop" ? "product-stop-button" : "product-send-button"
                }
                disabled={
                  operation !== null ||
                  (composerAction === "stop"
                    ? !canMutate || selectedDelegatedSession !== null
                    : !hasComposerDraft || !canSendComposer)
                }
                onClick={() => (composerAction === "stop" ? void cancelTurn() : sendComposer())}
                title={composerActionLabel}
                aria-label={composerActionLabel}
                type="button"
              >
                {composerAction === "stop" ? "■" : "↑"}
              </button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
