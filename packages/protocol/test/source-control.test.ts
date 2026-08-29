import { describe, expect, it } from "vitest";
import {
  parseConnectGitLabProjectRequest,
  parseSourceControlWorkspaceCheckoutRequest,
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

  it("carries the provider into the trusted Git checkout boundary", () => {
    expect(
      parseSourceControlWorkspaceCheckoutRequest({
        sourceControlProtocolVersion: 4,
        type: "source_control.workspace_checkout",
        requestId: "10000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
        workspaceId: "10000000-0000-4000-8000-000000000002",
        repositoryId: "10000000-0000-4000-8000-000000000003",
        provider: "gitlab",
        providerInstallationId: "501",
        providerRepositoryId: "501",
        cloneUrl: "http://gitlab.localhost:8929/team/private-repository.git",
        userCloneUrl: "http://gitlab.localhost:8929/team/private-repository.git",
        baseRef: "main",
        branchName: "picloud/issue-1-test",
        workTreePath: ".",
        accessToken: "glpat-project-scoped-token",
      }),
    ).toMatchObject({ provider: "gitlab", sourceControlProtocolVersion: 4 });
  });
});
