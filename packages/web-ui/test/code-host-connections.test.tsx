import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiCloudApi } from "../src/api.ts";
import { CodeHostConnectionsModal } from "../src/CodeHostConnectionsModal.tsx";
import { I18nProvider } from "../src/i18n.tsx";

describe("Code Host connections", () => {
  it("renders an environment-scoped GitLab/GitHub connection form without exposing a repository field", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLanguage="zh-CN">
        <CodeHostConnectionsModal
          api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
          defaultOrigin="https://gitlab.example.com"
          defaultProvider="gitlab"
          onClose={() => undefined}
          workspaceId="10000000-0000-4000-8000-000000000001"
          workspaceName="Backend Workspace"
        />
      </I18nProvider>,
    );
    expect(markup).toContain("代码托管连接");
    expect(markup).toContain("https://gitlab.example.com");
    expect(markup).toContain("访问令牌");
    expect(markup).toContain("GitHub");
    expect(markup).not.toContain("仓库地址");
  });
});
