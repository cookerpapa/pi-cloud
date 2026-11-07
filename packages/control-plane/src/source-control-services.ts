import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { GitHubAppClient } from "./github-app-client.ts";
import { SourceControlService } from "./source-control-service.ts";
import { SourceControlCredentialVault } from "./source-control-credential-vault.ts";
import type { loadProductionControlPlaneConfig } from "./production-config.ts";

/** HTTP API and management background reconcilers share adapters, never scheduler ownership. */
export function createSourceControlServices(
  database: Kysely<Database>,
  config: Awaited<ReturnType<typeof loadProductionControlPlaneConfig>>,
) {
  let sourceControlDispatcher: EnvHttpProxyAgent | undefined;
  let internalSourceControlDispatcher: Agent | undefined;
  let githubRuntime;
  if (config.githubApp !== undefined || config.gitlabProject !== undefined) {
    sourceControlDispatcher ??= new EnvHttpProxyAgent();
  }
  if (config.gitlabProject?.internalBaseUrl !== undefined) {
    internalSourceControlDispatcher = new Agent();
  }
  if (config.githubApp !== undefined) {
    const dispatcher = sourceControlDispatcher!;
    githubRuntime = {
      issueLabel: config.githubApp.issueLabel,
      client: new GitHubAppClient({
        appId: config.githubApp.appId,
        privateKeyPem: config.githubApp.privateKeyPem,
        webhookSecret: config.githubApp.webhookSecret,
        fetch: (input, init) =>
          undiciFetch(input as Parameters<typeof undiciFetch>[0], {
            ...(init as Parameters<typeof undiciFetch>[1]),
            dispatcher,
          }) as unknown as Promise<Response>,
      }),
    };
  }
  const gitlabRuntime =
    config.gitlabProject === undefined
      ? undefined
      : {
          vault: new SourceControlCredentialVault(config.gitlabProject.credentialMasterKey),
          webhookUrl: config.gitlabProject.webhookUrl,
          publicOrigin: config.publicOriginBaseUrl,
          issueLabel: config.gitlabProject.issueLabel,
          ...(config.gitlabProject.internalBaseUrl === undefined
            ? {}
            : { internalBaseUrl: config.gitlabProject.internalBaseUrl }),
          ...(config.gitlabProject.workspaceBaseUrl === undefined
            ? {}
            : { workspaceBaseUrl: config.gitlabProject.workspaceBaseUrl }),
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            undiciFetch(input as Parameters<typeof undiciFetch>[0], {
              ...(init as Parameters<typeof undiciFetch>[1]),
              dispatcher:
                config.gitlabProject!.internalBaseUrl === undefined
                  ? sourceControlDispatcher!
                  : internalSourceControlDispatcher!,
            }) as unknown as Promise<Response>,
        };
  const sourceControlService = new SourceControlService({
    database,
    workspaceServiceToken: config.workspaceServiceToken,
    allowInsecureInternalHttp: config.allowInsecureInternalHttp,
    ...(githubRuntime === undefined ? {} : { github: githubRuntime }),
    ...(gitlabRuntime === undefined ? {} : { gitlab: gitlabRuntime }),
  });
  return {
    sourceControlService,
    close: async () => {
      await Promise.all([
        sourceControlDispatcher?.close(),
        internalSourceControlDispatcher?.close(),
      ]);
    },
  };
}
