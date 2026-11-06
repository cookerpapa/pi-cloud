import { useEffect, useState } from "react";
import type { ModelBillingPage, ModelBillingSummary, ModelPrice } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

import { billingAmount as amount } from "./billing-format.ts";
export function ModelBilling({
  api,
  sessionId,
}: {
  api: PiCloudApi;
  sessionId?: string | undefined;
}) {
  const { language } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`),
    [to, setTo] = useState(today);
  const [model, setModel] = useState(""),
    [currentOnly, setCurrentOnly] = useState(false);
  const [query, setQuery] = useState(new URLSearchParams()),
    [pages, setPages] = useState<ModelBillingPage["next"][]>([null]);
  const [page, setPage] = useState<ModelBillingPage>(),
    [summary, setSummary] = useState<ModelBillingSummary>();
  const [error, setError] = useState<string>(),
    [loading, setLoading] = useState(true);
  const cursor = pages.at(-1);
  useEffect(() => {
    const abort = new AbortController(),
      params = new URLSearchParams(query);
    if (cursor) {
      params.set("beforeTime", cursor.time);
      params.set("beforeId", cursor.id);
    }
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.modelBilling(params, abort.signal),
      api.modelBillingSummary(query, abort.signal),
    ])
      .then(([rows, totals]) => {
        if (!abort.signal.aborted) {
          setPage(rows);
          setSummary(totals);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(say("暂时无法读取模型账单", "Model statement is temporarily unavailable"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, query, cursor]);
  function apply() {
    if (!from || !to || from > to) {
      setError(say("请选择有效日期范围", "Choose a valid date range"));
      return;
    }
    setPages([null]);
    setQuery(
      new URLSearchParams({
        from: new Date(`${from}T00:00:00Z`).toISOString(),
        to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(currentOnly && sessionId ? { sessionId } : {}),
      }),
    );
  }
  function exportPage() {
    if (!page) return;
    const url = URL.createObjectURL(
      new Blob([page.items.map((item) => JSON.stringify(item)).join("\n")], {
        type: "application/x-ndjson",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "model-usage.ndjson";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const price = (p?: ModelPrice) =>
    !p
      ? "—"
      : p.state === "unconfirmed"
        ? say("未确认", "Unconfirmed")
        : p.state === "unpriced"
          ? say("未定价", "Unpriced")
          : p.state === "waived"
            ? say("已免计", "Waived")
            : "amountPico" in p
              ? `${p.currency} ${amount(p.amountPico)}`
              : "—";
  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label>
          {say("开始日期（UTC）", "From (UTC)")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {say("结束日期（UTC）", "To (UTC)")}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <input
          aria-label={say("模型", "Model")}
          placeholder={say("全部模型", "All models")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        {sessionId ? (
          <label>
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => setCurrentOnly(e.target.checked)}
            />
            {say("当前会话", "Current conversation")}
          </label>
        ) : null}
        <button type="submit" disabled={loading}>
          {say("查询", "Apply")}
        </button>
        <button type="button" disabled={!page || loading} onClick={exportPage}>
          {say("导出本页", "Export page")}
        </button>
      </form>
      {summary ? (
        <div className="product-billing-totals">
          {summary.categories
            .filter((c) => c.kind === "customer")
            .map((c) => (
              <span key={`${c.state}:${c.currency}`}>
                {c.state === "priced"
                  ? `${say("已计价", "Priced")} ${c.currency} ${amount(c.amountPico!)}`
                  : c.state === "waived"
                    ? say("已免计", "Waived")
                    : c.state === "unpriced"
                      ? say("未定价", "Unpriced")
                      : say("未确认用量", "Unconfirmed usage")}{" "}
                · {c.count} {say("次", "attempts")}
              </span>
            ))}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="product-billing-table" aria-busy={loading}>
        <table>
          <thead>
            <tr>
              {[
                say("时间", "Time"),
                say("模型 / 用途", "Model / purpose"),
                say("输入", "Input"),
                say("缓存读 / 写", "Cache read / write"),
                say("输出 / 推理", "Output / reasoning"),
                say("模拟金额", "Quoted cost"),
                say("上游估算", "Upstream estimate"),
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.flatMap((item) =>
              item.usage.length
                ? item.usage.map((u) => (
                    <tr key={u.executionId}>
                      <td>{new Date(u.occurredAt).toLocaleString(language)}</td>
                      <td>
                        {u.usage.model}
                        <small>
                          {item.context.purpose === "image"
                            ? say("生图", "Image")
                            : item.context.purpose === "context_maintenance"
                              ? say("压缩", "Compaction")
                              : say("对话", "Conversation")}
                          {item.state === "unconfirmed"
                            ? ` · ${say("部分用量未确认", "Some usage is unconfirmed")}`
                            : item.state === "pending"
                              ? ` · ${say("尚未结束", "In progress")}`
                              : ""}
                          {u.usage.failed ? ` · ${say("失败尝试", "Failed attempt")}` : ""}
                        </small>
                      </td>
                      <td>{u.usage.tokens.input.toLocaleString()}</td>
                      <td>
                        {u.usage.tokens.cacheRead.toLocaleString()} /{" "}
                        {u.usage.tokens.cacheWrite.toLocaleString()}
                      </td>
                      <td>
                        {u.usage.tokens.output.toLocaleString()} /{" "}
                        {u.usage.tokens.reasoning.toLocaleString()}
                      </td>
                      <td>{price(u.valuation.customer)}</td>
                      <td>{price(u.valuation.upstream_estimate)}</td>
                    </tr>
                  ))
                : [
                    <tr key={item.context.invocationId}>
                      <td>{new Date(item.context.requestedAt).toLocaleString(language)}</td>
                      <td>{item.context.model}</td>
                      <td colSpan={5}>
                        {item.state === "pending"
                          ? say("等待用量回执", "Awaiting usage receipt")
                          : say("用量未确认", "Usage unconfirmed")}
                      </td>
                    </tr>,
                  ],
            )}
          </tbody>
        </table>
        {!loading && !page?.items.length ? (
          <p>{say("所选时间内暂无用量记录", "No usage records in this period")}</p>
        ) : null}
      </div>
      <footer>
        <button
          type="button"
          disabled={loading || pages.length === 1}
          onClick={() => setPages((p) => p.slice(0, -1))}
        >
          {say("上一页", "Previous")}
        </button>
        <span>{pages.length}</span>
        <button
          type="button"
          disabled={loading || !page?.next}
          onClick={() => setPages((p) => [...p, page!.next])}
        >
          {say("下一页", "Next")}
        </button>
      </footer>
    </section>
  );
}
