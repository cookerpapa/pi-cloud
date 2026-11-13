import { useEffect, useState } from "react";
import type { ResourceBillingSummary, ResourceStatementPage } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { billingAmount } from "./billing-format.ts";

export function ResourceBilling({ api, kind }: { api: PiCloudApi; kind: "compute" | "workspace" }) {
  const { language } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`),
    [to, setTo] = useState(today);
  const [query, setQuery] = useState(new URLSearchParams({ resourceKind: kind }));
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<ResourceStatementPage>(),
    [summary, setSummary] = useState<ResourceBillingSummary>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const cursor = cursors.at(-1);
  useEffect(() => {
    const controller = new AbortController(),
      params = new URLSearchParams(query);
    if (cursor) params.set("afterResourceKey", cursor);
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.resourceBilling(params, controller.signal),
      api.resourceBillingSummary(query, controller.signal),
    ])
      .then(([rows, totals]) => {
        if (!controller.signal.aborted) {
          setPage(rows);
          setSummary(totals);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(say("暂时无法读取资源账单", "Resource statement is temporarily unavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, cursor, query]);
  const describe = (
    charges: ResourceStatementPage["items"][number]["charges"],
    priceKind: string,
  ) =>
    charges
      .filter((c) => c.kind === priceKind)
      .map((c) =>
        c.state === "priced"
          ? `${c.currency} ${billingAmount(c.amountPico!)}`
          : c.state === "unpriced"
            ? say("未定价", "Unpriced")
            : say("用量未确认", "Unconfirmed usage"),
      )
      .join(" · ") || "—";
  function apply() {
    if (!from || !to || from > to) {
      setError(say("请选择有效日期范围", "Choose a valid date range"));
      return;
    }
    setCursors([null]);
    setQuery(
      new URLSearchParams({
        resourceKind: kind,
        from: new Date(`${from}T00:00:00Z`).toISOString(),
        to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
      }),
    );
  }
  function exportRows() {
    if (!page) return;
    const url = URL.createObjectURL(
      new Blob([page.items.map((row) => JSON.stringify(row)).join("\n")], {
        type: "application/x-ndjson",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "resource-statement.ndjson";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section>
      <form
        onSubmit={(event) => {
          event.preventDefault();
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
        <button type="submit" disabled={loading}>
          {say("查询", "Apply")}
        </button>
        <button
          type="button"
          disabled={loading || !page?.items.length}
          onClick={() => {
            void exportRows();
          }}
        >
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
                  ? `${say("已计价", "Priced")} ${c.currency} ${billingAmount(c.amountPico!)}`
                  : c.state === "unpriced"
                    ? say("未定价", "Unpriced")
                    : say("部分用量未确认", "Some usage is unconfirmed")}
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
                say("资源 / 工作区", "Resource / workspace"),
                say("规格", "Capacity"),
                kind === "compute"
                  ? say("计费服务分钟", "Billable service minutes")
                  : say("已确认时长", "Confirmed duration"),
                say("待核实", "Unconfirmed"),
                say("模拟金额", "Quoted cost"),
                say("上游估算", "Upstream estimate"),
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.map((item) => (
              <tr key={item.resource.resourceId}>
                <td title={item.resource.resourceId}>
                  {item.resource.resourceId.slice(0, 12)}
                  <small title={item.resource.workspaceId ?? undefined}>
                    {item.resource.workspaceId?.slice(0, 12) ?? say("设备", "Device")}
                  </small>
                </td>
                <td>
                  {item.quantity.kind === "compute"
                    ? `${item.quantity.cpuMillis / 1000} vCPU · ${item.quantity.memoryBytes / 1024 ** 3} GiB`
                    : `${item.quantity.capacityBytes / 1024 ** 3} GiB`}
                </td>
                <td>
                  {kind === "compute"
                    ? `${Math.floor(Number(item.confirmedMilliseconds) / 60_000)} min`
                    : `${(Number(item.confirmedMilliseconds) / 3_600_000).toFixed(3)} h`}
                </td>
                <td>
                  {Number(item.unconfirmedMilliseconds)
                    ? `${(Number(item.unconfirmedMilliseconds) / 3_600_000).toFixed(3)} h`
                    : "—"}
                </td>
                <td>{describe(item.charges, "customer")}</td>
                <td>{describe(item.charges, "upstream_estimate")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !page?.items.length ? (
          <p>{say("所选时间内暂无用量记录", "No usage records in this period")}</p>
        ) : null}
      </div>
      <footer>
        <button
          type="button"
          disabled={loading || cursors.length === 1}
          onClick={() => setCursors((rows) => rows.slice(0, -1))}
        >
          {say("上一页", "Previous")}
        </button>
        <span>{cursors.length}</span>
        <button
          type="button"
          disabled={loading || !page?.next}
          onClick={() => setCursors((rows) => [...rows, page!.next])}
        >
          {say("下一页", "Next")}
        </button>
      </footer>
    </section>
  );
}
