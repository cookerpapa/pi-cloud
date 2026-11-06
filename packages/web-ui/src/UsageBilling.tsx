import { useState } from "react";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { ModelBilling } from "./ModelBilling.tsx";
import { ResourceBilling } from "./ResourceBilling.tsx";

export function UsageBilling({
  api,
  sessionId,
  onClose,
}: {
  api: PiCloudApi;
  sessionId?: string | undefined;
  onClose(): void;
}) {
  const { language } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const [kind, setKind] = useState<"model" | "compute" | "workspace">("model");
  return (
    <main className="product-resource-page product-billing-page">
      <header>
        <button type="button" className="product-secondary-button" onClick={onClose}>
          ← {say("返回", "Back")}
        </button>
        <h1>{say("用量与费用", "Usage and costs")}</h1>
        <span>{say("模拟账单 · 未扣款", "Statement only · No collection")}</span>
      </header>
      <nav className="product-billing-tabs" aria-label={say("用量类型", "Usage category")}>
        {(
          [
            ["model", say("模型", "Models")],
            ["compute", say("计算资源", "Compute")],
            ["workspace", say("存储", "Storage")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {kind === "model" ? (
        <ModelBilling api={api} sessionId={sessionId} />
      ) : (
        <ResourceBilling key={kind} api={api} kind={kind} />
      )}
    </main>
  );
}
