import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelCatalogEntryResource,
  ModelCatalogResource,
  SessionModelResource,
  SessionModelSelection,
  TurnThinkingLevel,
} from "@pi-cloud/protocol";
import type { Translate } from "./i18n.tsx";

type Provider = SessionModelSelection["provider"];
type ModelIdentity =
  | Pick<Extract<SessionModelSelection, { provider: "deepseek" }>, "provider" | "modelId">
  | Pick<Extract<SessionModelSelection, { provider: "openai-codex" }>, "provider" | "modelId">;

function modelKey(model: Pick<ModelCatalogEntryResource, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}

function modelSelection(
  model: ModelIdentity,
  thinkingLevel: TurnThinkingLevel,
  fastMode = false,
): SessionModelSelection {
  if (model.provider === "deepseek") {
    return { provider: model.provider, modelId: model.modelId, thinkingLevel, fastMode: false };
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel,
    fastMode,
  };
}

export function defaultModelSettings(model: ModelCatalogEntryResource): SessionModelSelection {
  return modelSelection(model, model.defaultThinkingLevel);
}

export function defaultNewConversationSettings(
  catalog: ModelCatalogResource,
): SessionModelSelection | null {
  const model =
    catalog.models.find(
      (candidate) => candidate.provider === "openai-codex" && candidate.modelId === "gpt-5.6-sol",
    ) ?? catalog.models.find((candidate) => candidate.provider === "openai-codex");
  if (model === undefined) return null;
  return modelSelection(
    model,
    model.thinkingLevels.includes("medium") ? "medium" : model.defaultThinkingLevel,
  );
}

export function settingsFromSessionModel(model: SessionModelResource): SessionModelSelection {
  return modelSelection(model, model.thinkingLevel, model.fastMode);
}

function providerName(provider: Provider, t: Translate): string {
  return provider === "openai-codex"
    ? t("chat.model.provider.gpt")
    : t("chat.model.provider.deepseek");
}

function thinkingName(level: TurnThinkingLevel, t: Translate): string {
  return t(`chat.model.thinking.${level}` as Parameters<Translate>[0]);
}

function sameModel(
  left: Pick<SessionModelSelection, "provider" | "modelId">,
  right: Pick<SessionModelSelection, "provider" | "modelId">,
): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

function MenuChevron() {
  return (
    <span aria-hidden="true" className="product-model-menu-chevron">
      ›
    </span>
  );
}

export function ModelSettingsMenu({
  catalog,
  value,
  disabled = false,
  onApply,
  t,
}: {
  catalog: ModelCatalogResource;
  value: SessionModelSelection;
  disabled?: boolean;
  onApply(value: SessionModelSelection): void | Promise<void>;
  t: Translate;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [activeModel, setActiveModel] = useState<ModelCatalogEntryResource | null>(null);
  const [draft, setDraft] = useState(value);
  const selectedModel = catalog.models.find((model) => sameModel(model, value));
  const providers = useMemo(
    () =>
      (["openai-codex", "deepseek"] as const).filter((provider) =>
        catalog.models.some((model) => model.provider === provider),
      ),
    [catalog.models],
  );
  const providerModels =
    activeProvider === null
      ? []
      : catalog.models.filter((model) => model.provider === activeProvider);

  const close = (): void => {
    setOpen(false);
    setActiveProvider(null);
    setActiveModel(null);
  };

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const chooseModel = (model: ModelCatalogEntryResource): void => {
    setDraft(sameModel(model, value) ? { ...value } : defaultModelSettings(model));
    setActiveModel(model);
  };

  const applyThinking = (thinkingLevel: TurnThinkingLevel): void => {
    const next = modelSelection(draft, thinkingLevel, draft.fastMode);
    void onApply(next);
    close();
  };

  const toggleFast = (): void => {
    if (draft.provider !== "openai-codex") return;
    const next = modelSelection(draft, draft.thinkingLevel, !draft.fastMode);
    setDraft(next);
    void onApply(next);
  };

  return (
    <div className="product-model-menu" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="product-model-menu-trigger"
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setDraft(value);
          setActiveProvider(null);
          setActiveModel(null);
          setOpen(true);
        }}
        title={t("chat.model.nextTurnHint")}
        type="button"
      >
        <span aria-hidden="true" className="product-model-menu-mark">
          ✦
        </span>
        <strong>{selectedModel?.displayName ?? value.modelId}</strong>
        <small>{thinkingName(value.thinkingLevel, t)}</small>
        {value.fastMode ? <em>{t("chat.model.fast")}</em> : null}
        <span aria-hidden="true" className="product-model-menu-caret">
          ⌃
        </span>
      </button>
      {!open ? null : (
        <div className="product-model-menu-flyouts">
          <div
            aria-label={t("chat.model.provider")}
            className="product-model-menu-panel"
            role="menu"
          >
            <span className="product-model-menu-heading">{t("chat.model.provider")}</span>
            {providers.map((provider) => (
              <button
                aria-current={activeProvider === provider ? "true" : undefined}
                disabled={disabled}
                key={provider}
                onClick={() => {
                  setActiveProvider(provider);
                  setActiveModel(null);
                }}
                role="menuitem"
                type="button"
              >
                <span>{providerName(provider, t)}</span>
                <MenuChevron />
              </button>
            ))}
          </div>

          {activeProvider === null ? null : (
            <div
              aria-label={t("chat.model.model")}
              className="product-model-menu-panel product-model-menu-subpanel"
              role="menu"
            >
              <span className="product-model-menu-heading">{providerName(activeProvider, t)}</span>
              {providerModels.map((model) => (
                <button
                  aria-current={
                    activeModel !== null && modelKey(activeModel) === modelKey(model)
                      ? "true"
                      : undefined
                  }
                  disabled={disabled}
                  key={modelKey(model)}
                  onClick={() => chooseModel(model)}
                  role="menuitem"
                  type="button"
                >
                  <span>{model.displayName}</span>
                  {sameModel(model, value) ? <span aria-hidden="true">✓</span> : <MenuChevron />}
                </button>
              ))}
            </div>
          )}

          {activeModel === null ? null : (
            <div
              aria-label={t("chat.model.reasoning")}
              className="product-model-menu-panel product-model-menu-subpanel"
              role="menu"
            >
              <span className="product-model-menu-heading">{t("chat.model.reasoning")}</span>
              {activeModel.thinkingLevels.map((level) => (
                <button
                  aria-current={draft.thinkingLevel === level ? "true" : undefined}
                  disabled={disabled}
                  key={level}
                  onClick={() => applyThinking(level)}
                  role="menuitem"
                  type="button"
                >
                  <span>{thinkingName(level, t)}</span>
                  {draft.thinkingLevel === level ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
              {!activeModel.fastModeAvailable || activeProvider !== "openai-codex" ? null : (
                <button
                  aria-checked={draft.fastMode}
                  className="product-model-menu-fast"
                  disabled={disabled}
                  onClick={toggleFast}
                  role="menuitemcheckbox"
                  type="button"
                >
                  <span>
                    <strong>{t("chat.model.fast")}</strong>
                    <small>{t("chat.model.fastHint")}</small>
                  </span>
                  <i aria-hidden="true" className={draft.fastMode ? "enabled" : ""} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
