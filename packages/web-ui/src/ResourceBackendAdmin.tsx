import { useEffect, useState } from "react";
import type { ResourceBackendResource, ResourceBackendConfiguration } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

export function ResourceBackendAdmin({ api }: { api: PiCloudApi }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [items, setItems] = useState<readonly ResourceBackendResource[]>([]);
  const [kind, setKind] = useState<"cubesandbox" | "boxlite" | "device">("boxlite");
  const [id, setId] = useState(() => "sandbox-domain-" + crypto.randomUUID().slice(0, 8));
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [deviceTenantId, setDeviceTenantId] = useState("");
  const [storageUrl, setStorageUrl] = useState("");
  const [storageToken, setStorageToken] = useState("");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState(80);
  const [sandboxDomain, setSandboxDomain] = useState("cube.app");
  const [egressHost, setEgressHost] = useState("10.255.255.254");
  const [imageRevision, setImageRevision] = useState("");
  const [operatingSystem, setOperatingSystem] = useState("Linux");
  const [templates, setTemplates] = useState({
    elastic: "tool",
    starter: "starter",
    standard: "standard",
    performance: "performance",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api
      .resourceBackends(true)
      .then((r) => {
        if (cancelled) return;
        setItems(r.backends);
        setImageRevision(r.backends[0]?.templates[0]?.imageRevision ?? "");
      })
      .catch(() => {
        if (!cancelled) setError(zh ? "集群目录暂不可用" : "Backend catalog unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [api, zh]);
  const change = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setItems((await api.resourceBackends(true)).backends);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };
  const field = (
    label: string,
    value: string,
    set: (value: string) => void,
    type = "text",
    placeholder?: string,
  ) => (
    <label>
      <span>{label}</span>
      <input
        required
        type={type}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        maxLength={type === "password" ? 4096 : 2048}
      />
    </label>
  );
  return (
    <section className="resource-backend-admin">
      <h2>{zh ? "沙箱集群与设备" : "Sandbox backends and devices"}</h2>
      {items.map((item) => (
        <div className="admin-settings-row" key={item.id}>
          <span>
            {item.name} · {item.location} · {item.provider}
          </span>
          <select
            aria-label={`${item.name} ${zh ? "状态" : "state"}`}
            value={item.state}
            disabled={busy}
            onChange={(e) =>
              void change(() =>
                api.putResourceBackend({
                  id: item.id,
                  name: item.name,
                  location: item.location,
                  expectedRevision: item.revision,
                  state: e.target.value as ResourceBackendResource["state"],
                }),
              )
            }
          >
            <option value="active">{zh ? "可新建" : "Available"}</option>
            <option value="draining">{zh ? "停止新建" : "Draining"}</option>
            <option value="disabled">{zh ? "禁用新建" : "Disabled"}</option>
          </select>
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void change(async () => {
            if (kind === "device")
              await api.registerResourceDevice({
                tenantId: deviceTenantId,
                device: { targetId: nodeId, name, endpoint: url },
              });
            else {
              const configuration: ResourceBackendConfiguration = {
                compute:
                  kind === "boxlite"
                    ? { provider: kind, url, token, nodeId }
                    : {
                        provider: kind,
                        apiUrl: url,
                        apiKey: token,
                        proxyNodeIp: proxyHost,
                        proxyPort,
                        proxyScheme: "http",
                        sandboxDomain,
                      },
                storage: { url: storageUrl, token: storageToken },
                webProxy: { host: egressHost, port: 3128, directPrivateCidrs: [] },
                templates: [
                  {
                    id: "linux",
                    name: "Linux",
                    operatingSystem,
                    imageRevision,
                    elasticTemplateId: templates.elastic,
                    profiles: {
                      starter: templates.starter,
                      standard: templates.standard,
                      performance: templates.performance,
                    },
                  },
                ],
              };
              await api.putResourceBackend({
                id,
                name,
                location,
                expectedRevision: 0,
                state: "active",
                configuration,
              });
            }
            setToken("");
            setStorageToken("");
            setName("");
            setId("sandbox-domain-" + crypto.randomUUID().slice(0, 8));
          });
        }}
      >
        <label>
          <span>{zh ? "类型" : "Type"}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="boxlite">BoxLite</option>
            <option value="cubesandbox">Cube</option>
            <option value="device">
              {zh ? "已有设备 · Android / Linux" : "Existing device · Android / Linux"}
            </option>
          </select>
        </label>
        {field(zh ? "名称" : "Name", name, setName)}
        {kind === "device" &&
          field(zh ? "所属组织 ID" : "Organization ID", deviceTenantId, setDeviceTenantId)}
        {kind !== "device" && (
          <>
            {field(zh ? "集群标识" : "Backend ID", id, setId)}
            {field(zh ? "位置" : "Location", location, setLocation)}
          </>
        )}
        {field(zh ? "管理地址" : "Management endpoint", url, setUrl, "url", "https://…")}
        {kind !== "cubesandbox" &&
          field(
            kind === "device" ? (zh ? "设备 UUID" : "Device UUID") : zh ? "节点标识" : "Node ID",
            nodeId,
            setNodeId,
          )}
        {kind !== "device" && (
          <>
            {field(zh ? "管理凭证" : "Management credential", token, setToken, "password")}
            {field(zh ? "存储地址" : "Storage endpoint", storageUrl, setStorageUrl, "url")}
            {field(
              zh ? "存储凭证" : "Storage credential",
              storageToken,
              setStorageToken,
              "password",
            )}
            {kind === "cubesandbox" && (
              <>
                {field(zh ? "Cube 代理地址" : "Cube proxy host", proxyHost, setProxyHost)}
                <label>
                  <span>{zh ? "Cube 代理端口" : "Cube proxy port"}</span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    value={proxyPort}
                    onChange={(e) => setProxyPort(Number(e.target.value))}
                  />
                </label>
                {field(zh ? "Cube 域名" : "Cube domain", sandboxDomain, setSandboxDomain)}
              </>
            )}
            {field(zh ? "出口网关" : "Egress gateway", egressHost, setEgressHost)}
            {field(zh ? "环境系统" : "Operating system", operatingSystem, setOperatingSystem)}
            {field(
              zh ? "已部署 Guest 版本" : "Deployed Guest revision",
              imageRevision,
              setImageRevision,
            )}
            {(["elastic", "starter", "standard", "performance"] as const).map((key) => (
              <label key={key}>
                <span>
                  {zh
                    ? {
                        elastic: "弹性模板",
                        starter: "轻量模板",
                        standard: "标准模板",
                        performance: "高性能模板",
                      }[key]
                    : `${key} template`}
                </span>
                <input
                  required
                  value={templates[key]}
                  maxLength={128}
                  onChange={(e) => setTemplates((t) => ({ ...t, [key]: e.target.value }))}
                />
              </label>
            ))}
          </>
        )}
        <button className="product-primary-button" type="submit" disabled={busy}>
          {busy ? (zh ? "验证中…" : "Validating…") : zh ? "登记" : "Register"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
