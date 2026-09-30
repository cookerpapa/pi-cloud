import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { DevelopmentEnvironmentResource, WorkspaceSummaryResource } from "@pi-cloud/protocol";
import { DEFAULT_EXCLUSIVE_WORKING_DIRECTORY } from "@pi-cloud/protocol";
import { PiCloudApi, newIdempotencyKey } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";

const DirectoryPicker = lazy(() =>
  import("./WorkspaceDirectoryPicker.tsx").then((m) => ({ default: m.WorkspaceDirectoryPicker })),
);
type Choice = "existing" | "new" | "machine";

/** Recovery choices belong to this dialog, independently of the new-chat composer. */
export function WorkspaceRebindDialog({
  api,
  sessionId,
  workspaces,
  environments,
  canMutate,
  onRefresh,
  onBound,
  onClose,
  onOpenResources,
}: {
  api: PiCloudApi;
  sessionId: string;
  workspaces: readonly WorkspaceSummaryResource[];
  environments: readonly DevelopmentEnvironmentResource[];
  canMutate: boolean;
  onRefresh(): Promise<void>;
  onBound(sessionId: string): Promise<void>;
  onClose(): void;
  onOpenResources(): void;
}) {
  const { t } = useI18n();
  const [selectedChoice, setChoice] = useState<Choice | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string>(DEFAULT_EXCLUSIVE_WORKING_DIRECTORY);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<
    { fingerprint: string; key: string; createdWorkspaceId?: string } | undefined
  >(undefined);
  const machines = environments.filter((m) => ["running", "paused"].includes(m.state));
  const choice =
    selectedChoice ?? (workspaces.length ? "existing" : machines.length ? "machine" : "new");
  const workspace =
    workspaces.find((w) => w.workspaceId === workspaceId) ??
    (workspaceId ? undefined : workspaces[0]);
  const machine =
    machines.find((m) => m.environmentId === machineId) ?? (machineId ? undefined : machines[0]);
  const failure = (e: unknown) => errorMessage(e, t);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void onRefresh()
      .catch((e: unknown) => {
        if (active) setError(errorMessage(e, t));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onRefresh, t]);

  async function resumeMachine() {
    if (machine?.state === "paused") {
      await api.developmentEnvironmentAction(
        machine.environmentId,
        "resume",
        newIdempotencyKey("environment"),
      );
      await onRefresh();
    }
  }
  async function openDirectoryPicker() {
    if (busy || !machine) return;
    setBusy(true);
    setError(null);
    try {
      await resumeMachine();
      setPicker(true);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  async function bind() {
    if (busy || loading || !canMutate) return;
    if (
      (choice === "existing" && !workspace) ||
      (choice === "machine" && !machine) ||
      (choice === "new" && !name.trim())
    )
      return;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify([
      choice,
      choice === "new"
        ? name.trim()
        : choice === "machine"
          ? machine!.environmentId
          : workspace!.workspaceId,
      choice === "machine" ? cwd : "/workspace",
    ]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newIdempotencyKey("workspace-rebind") };
    const current = attempt.current;
    try {
      let target: string;
      if (choice === "machine") {
        await resumeMachine();
        target = machine!.workspaceId;
      } else if (choice === "existing") target = workspace!.workspaceId;
      else {
        current.createdWorkspaceId ??= (await api.createProject(name.trim())).workspaceId;
        target = current.createdWorkspaceId;
      }
      await api.rebindConversationWorkspace(
        sessionId,
        target,
        current.key,
        choice === "machine" ? cwd : undefined,
      );
      await onBound(sessionId);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  if (picker && machine)
    return (
      <Suspense fallback={null}>
        <DirectoryPicker
          api={api}
          environmentId={machine.environmentId}
          initialDirectory={cwd}
          workspaceName={machine.workspaceName}
          onChoose={(path) => {
            setCwd(path);
            setPicker(false);
          }}
          onCancel={() => setPicker(false)}
        />
      </Suspense>
    );
  return (
    <div className="product-modal-backdrop" role="presentation">
      <form
        className="product-workspace-modal product-rebind-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.rebind.title")}
        onSubmit={(e) => {
          e.preventDefault();
          void bind();
        }}
      >
        <header>
          <div>
            <h2>{t("chat.rebind.title")}</h2>
            <p>{t("chat.rebind.description")}</p>
          </div>
          <button disabled={busy} onClick={onClose} type="button">
            ×
          </button>
        </header>
        {error ? (
          <p role="alert" className="product-turn-error">
            {error}
          </p>
        ) : null}
        <fieldset className="product-workspace-choice" disabled={busy || loading || !canMutate}>
          <legend>{t("chat.rebind.workspace")}</legend>
          {workspaces.length ? (
            <label className="product-choice-card">
              <input
                type="radio"
                name="rebind-choice"
                checked={choice === "existing"}
                onChange={() => setChoice("existing")}
              />
              <span>
                <strong>{t("chat.rebind.existing")}</strong>
                <small>{t("chat.rebind.existingDescription")}</small>
              </span>
            </label>
          ) : null}
          {choice === "existing" && workspaces.length ? (
            <select
              aria-label={t("chat.rebind.existing")}
              value={workspace?.workspaceId ?? ""}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              <option value="" disabled>
                {t("chat.create.workspaceSelect")}
              </option>
              {workspaces.map((w) => (
                <option key={w.workspaceId} value={w.workspaceId}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
          <label className="product-choice-card">
            <input
              type="radio"
              name="rebind-choice"
              checked={choice === "new"}
              onChange={() => setChoice("new")}
            />
            <span>
              <strong>{t("chat.rebind.new")}</strong>
              <small>{t("chat.rebind.newDescription")}</small>
            </span>
          </label>
          {choice === "new" ? (
            <input
              aria-label={t("chat.rebind.new")}
              maxLength={256}
              value={name}
              placeholder={t("chat.rebind.placeholder")}
              onChange={(e) => {
                setChoice("new");
                setName(e.target.value);
              }}
            />
          ) : null}
          <label className="product-choice-card">
            <input
              type="radio"
              name="rebind-choice"
              checked={choice === "machine"}
              onChange={() => setChoice("machine")}
            />
            <span>
              <strong>{t("chat.rebind.machine")}</strong>
              <small>{t("chat.rebind.machineDescription")}</small>
            </span>
          </label>
          {choice === "machine" ? (
            machines.length ? (
              <>
                <select
                  aria-label={t("chat.create.selectExclusive")}
                  value={machine?.environmentId ?? ""}
                  onChange={(e) => {
                    setMachineId(e.target.value);
                    setCwd(DEFAULT_EXCLUSIVE_WORKING_DIRECTORY);
                  }}
                >
                  <option value="" disabled>
                    {t("chat.create.selectExclusive")}
                  </option>
                  {machines.map((m) => (
                    <option key={m.environmentId} value={m.environmentId}>
                      {m.workspaceName} · {m.cpuCount}C / {m.memoryMiB / 1024}G
                      {m.state === "paused" ? ` · ${t("chat.rebind.paused")}` : ""}
                    </option>
                  ))}
                </select>
                <div className="product-working-directory-choice">
                  <div>
                    <span>{t("chat.create.workingDirectory")}</span>
                    <code>{cwd}</code>
                  </div>
                  <button
                    type="button"
                    disabled={!machine}
                    onClick={() => void openDirectoryPicker()}
                  >
                    {t("chat.create.chooseDirectory")}
                  </button>
                </div>
              </>
            ) : (
              <div className="product-resource-boundary-note">
                {t("chat.create.noExclusive")}
                <button type="button" onClick={onOpenResources}>
                  {t("chat.create.openResources")}
                </button>
              </div>
            )
          ) : null}
        </fieldset>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="product-primary-button"
            type="submit"
            disabled={
              busy ||
              loading ||
              !canMutate ||
              (choice === "existing" && !workspace) ||
              (choice === "machine" && !machine) ||
              (choice === "new" && !name.trim())
            }
          >
            {busy ? t("chat.rebind.binding") : t("chat.rebind.submit")}
          </button>
        </footer>
      </form>
    </div>
  );
}
