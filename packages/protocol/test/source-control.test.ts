import { describe, expect, it } from "vitest";
import {
  parseCodeHostConnectionListResource,
  parseConnectCodeHostRequest,
  parseConnectGitLabProjectRequest,
  parseStartSourceControlIssueJobRequest,
  parseSourceControlWorkspaceCredentialRequest,
} from "../src/index.ts";

describe("source-control protocol", () => {
  it("accepts a bounded self-managed GitLab project connection", () => {
    expect(
      parseConnectGitLabProjectRequest({
        baseUrl: "http://gitlab.localhost:8929",
        project: "team/private-repository",
        accessToken: "glpat-project-scoped-token",
      }),
    ).toMatchObject({ project: "team/private-repository" });
  });

  it("carries a user credential into the Workspace credential boundary without cloning", () => {
    expect(
      parseSourceControlWorkspaceCredentialRequest({
        sourceControlProtocolVersion: 1,
        type: "source_control.workspace_credential_authorize",
        requestId: "10000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
        workspaceId: "10000000-0000-4000-8000-000000000002",
        provider: "gitlab",
        origin: "http://gitlab.localhost:8929",
        credentialMountPath: "/workspace",
        accessToken: "glpat-project-scoped-token",
      }),
    ).toMatchObject({ provider: "gitlab", sourceControlProtocolVersion: 1 });
  });

  it("models environment Code Host connections by provider and Origin", () => {
    expect(
      parseConnectCodeHostRequest({
        provider: "gitlab",
        origin: "https://gitlab.example.com/",
        accessToken: "glpat-environment-token",
      }),
    ).toMatchObject({ provider: "gitlab" });
    expect(
      parseCodeHostConnectionListResource({
        connections: [
          { provider: "github", origin: "https://github.com" },
          { provider: "gitlab", origin: "https://gitlab.example.com" },
        ],
      }),
    ).toHaveProperty("connections", expect.any(Array));
  });

  it("accepts a named Issue Session with an optional existing Workspace", () => {
    expect(
      parseStartSourceControlIssueJobRequest({
        executionMode: "elastic",
        sessionTitle: "  Repair private sorting Issue  ",
        sandboxProfileKey: "standard",
        workspaceId: "10000000-0000-4000-8000-000000000004",
      }),
    ).toEqual({
      executionMode: "elastic",
      sessionTitle: "Repair private sorting Issue",
      sandboxProfileKey: "standard",
      workspaceId: "10000000-0000-4000-8000-000000000004",
    });
  });
});
