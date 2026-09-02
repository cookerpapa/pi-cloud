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

export function defaultModelSettings(model: ModelCatalogEntryResource): SessionModelSelection {
  if (model.provider === "deepseek") {
    return {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.defaultThinkingLevel,
      fastMode: false,
    };
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.defaultThinkingLevel,
    fastMode: false,
  };
}

export function settingsFromSessionModel(model: SessionModelResource): SessionModelSelection {
  if (model.provider === "deepseek") {
    return {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
      fastMode: false,
    };
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel,
    fastMode: model.fastMode,
  };
}

function providerName(provider: Provider, t: Translate): string {
  return provider === "openai-codex"
    ? t("chat.model.provider.gpt")
    : t("chat.model.provider.deepseek");
}

function thinkingName(level: TurnThinkingLevel, t: Translate): string {
  return t(`chat.model.thinking.${level}` as Parameters<Translate>[0]);
}

function selectionKey(selection: SessionModelSelection): string {
  return [
    selection.provider,
    selection.modelId,
    selection.thinkingLevel,
    selection.fastMode ? "fast" : "standard",
  ].join(":");
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
  const [draft, setDraft] = useState(value);
  const selectedModel = catalog.models.find(
    (model) => model.provider === value.provider && model.modelId === value.modelId,
  );
  const draftModel = catalog.models.find(
    (model) => model.provider === draft.provider && model.modelId === draft.modelId,
  );
  const providers = useMemo(
    () =>
      (["openai-codex", "deepseek"] as const).filter((provider) =>
        catalog.models.some((model) => model.provider === provider),
      ),
    [catalog.models],
  );
  const providerModels = catalog.models.filter((model) => model.provider === draft.provider);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const chooseProvider = (provider: Provider): void => {
    const model = catalog.models.find((candidate) => candidate.provider === provider);
    if (model !== undefined) setDraft(defaultModelSettings(model));
  };
  const chooseModel = (model: ModelCatalogEntryResource): void => {
    const next = defaultModelSettings(model);
    if (model.provider === "openai-codex" && draft.provider === "openai-codex") {
      next.fastMode = draft.fastMode;
    }
    setDraft(next);
  };

  return (
    <div className="product-model-menu" ref={root}>
      <button
        aria-expanded={open}
        className="product-model-menu-trigger"
        disabled={disabled}
        onClick={() => {
          setDraft(value);
          setOpen((current) => !current);
        }}
        title={t("chat.model.nextTurnHint")}
        type="button"
      >
        <span>{providerName(value.provider, t)}</span>
        <strong>{selectedModel?.displayName ?? value.modelId}</strong>
        <small>
          {thinkingName(value.thinkingLevel, t)}
          {value.fastMode ? ` · ${t("chat.model.fast")}` : ""}
        </small>
        <span aria-hidden="true">⌄</span>
      </button>
      {!open ? null : (
        <div className="product-model-menu-popover" role="dialog">
          <div className="product-model-menu-level">
            <span>{t("chat.model.provider")}</span>
            <div>
              {providers.map((provider) => (
                <button
                  aria-pressed={draft.provider === provider}
                  key={provider}
                  onClick={() => chooseProvider(provider)}
                  type="button"
                >
                  {providerName(provider, t)}
                </button>
              ))}
            </div>
          </div>
          <div className="product-model-menu-level">
            <span>{t("chat.model.model")}</span>
            <div>
              {providerModels.map((model) => (
                <button
                  aria-pressed={draft.modelId === model.modelId}
                  key={`${model.provider}:${model.modelId}`}
                  onClick={() => chooseModel(model)}
                  type="button"
                >
                  {model.displayName}
                </button>
              ))}
            </div>
          </div>
          {draftModel === undefined ? null : (
            <div className="product-model-menu-level">
              <span>{t("chat.model.reasoning")}</span>
              <div>
                {draftModel.thinkingLevels.map((level) => (
                  <button
                    aria-pressed={draft.thinkingLevel === level}
                    key={level}
                    onClick={() => setDraft({ ...draft, thinkingLevel: level })}
                    type="button"
                  >
                    {thinkingName(level, t)}
                  </button>
                ))}
              </div>
              {!draftModel.fastModeAvailable || draft.provider !== "openai-codex" ? null : (
                <label className="product-model-fast-toggle">
                  <span>
                    <strong>{t("chat.model.fast")}</strong>
                    <small>{t("chat.model.fastHint")}</small>
                  </span>
                  <input
                    checked={draft.fastMode}
                    onChange={(event) => setDraft({ ...draft, fastMode: event.target.checked })}
                    type="checkbox"
                  />
                </label>
              )}
            </div>
          )}
          <button
            className="product-model-menu-apply"
            disabled={selectionKey(draft) === selectionKey(value)}
            onClick={() => {
              void onApply(draft);
              setOpen(false);
            }}
            type="button"
          >
            {t("chat.model.apply")}
          </button>
        </div>
      )}
    </div>
  );
}
