import { describe, expect, it } from "vitest";
import {
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
        repositoryId: "10000000-0000-4000-8000-000000000003",
        provider: "gitlab",
        userCloneUrl: "http://gitlab.localhost:8929/team/private-repository.git",
        verificationCloneUrl: "http://gitlab.internal:8929/team/private-repository.git",
        credentialMountPath: "/workspace",
        accessToken: "glpat-project-scoped-token",
      }),
    ).toMatchObject({ provider: "gitlab", sourceControlProtocolVersion: 1 });
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
