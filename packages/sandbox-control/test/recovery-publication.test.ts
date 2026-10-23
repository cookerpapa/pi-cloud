// Recovered handles become public only after every fallible preparation succeeds.
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SandboxController } from "../src/sandbox-controller.ts";
import { CUBESANDBOX_TOOL_POLICY } from "../src/cubesandbox-sandbox-provider.ts";
import type { SandboxHandle, SandboxProvider } from "../src/sandbox-provider.ts";
import type { WorkspaceRuntimeStateRepository } from "../src/workspace-runtime-state-repository.ts";
import { InMemoryWorkspaceRuntimeStateRepository } from "./helpers/in-memory-workspace-runtime-state-repository.ts";
import { InMemorySandboxBindings } from "./helpers/in-memory-sandbox-bindings.ts";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@pi-cloud/protocol";

it.each(
  (["development", "elastic"] as const).flatMap((kind) =>
    (["bindings", "persist"] as const).map((stage) => ({ kind, stage })),
  ),
)(
  "retries $kind adoption after $stage fails without publishing a detached handle",
  async ({ kind, stage }) => {
    const id = randomUUID(),
      tenantId = randomUUID(),
      projectId = randomUUID(),
      workspaceId = randomUUID(),
      userId = randomUUID();
    const reservation = {
      environmentId: id,
      allocationId: id,
      intentRevision: 1,
      desiredState: "running" as const,
      tenantId,
      projectId,
      workspaceId,
      userId,
      environmentVersionId: randomUUID(),
      generation: 1,
      profileKey: "starter" as const,
    };
    const assignment = {
      tenantId,
      projectId,
      workspaceId,
      supervisorId: "development-environment",
      bootId: id,
      sandboxId: id,
      runId: id,
      sessionId: id,
      turnId: id,
      executionReference: createExecutionReference(id, id, 1),
    };
    const handle = {
      activationId: id,
      runtimeId: id,
      runtimeName: id.replaceAll("-", ""),
      runtimeNodeId: "node",
      providerApiVersion: 1,
      providerId: "cubesandbox",
      workspaceRoot: "/home/user",
      allocation: { createBefore: Date.now() + 300000 },
      assignment,
      environment: {
        environmentVersionId: reservation.environmentVersionId,
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
      environmentValidation: {
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        isolationBoundary: "microvm",
        runtime: "cubesandbox-kvm",
        networkMode: "public_web_proxy_private_denied",
        runAsUser: "1000:1000",
        readOnlyRootFilesystem: false,
        tools: [],
        recipeCommands: [],
      },
    } as SandboxHandle;
    let attached = false;
    const provider = {
      providerId: "cubesandbox",
      defaultPolicy: CUBESANDBOX_TOOL_POLICY,
      executionIdentity: () => {
        if (!attached) throw new Error("detached runtime handle");
        return id;
      },
      adoptPersistentCapsule: vi.fn(async () => {
        attached = true;
        return handle;
      }),
      persistentCapsule: async () => ({ handle, capsule: "review-capsule" }),
      inspect: async () => ({ state: "running" }),
      detachPersistent: vi.fn(async () => {
        attached = false;
      }),
      close: async () => {},
      observeRuntimeInventory: async () => new Map(),
    } as unknown as SandboxProvider;
    const state = new InMemoryWorkspaceRuntimeStateRepository() as WorkspaceRuntimeStateRepository;
    const bindings = new InMemorySandboxBindings();
    if (kind === "development") {
      vi.spyOn(state, "developmentEnvironmentOwner").mockResolvedValue({
        status: "owned",
        state: "ready",
        reservation,
        agentActive: false,
        terminalActive: false,
      });
      vi.spyOn(state, "claimRecoverableDevelopmentEnvironments").mockImplementation(
        async (_limit, excluded = []) =>
          excluded.includes(id)
            ? []
            : [
                {
                  reservation,
                  state: "ready",
                  allocationAbsent: false,
                  runtimeCapsule: "review-capsule",
                },
              ],
      );
    } else {
      vi.spyOn(state, "claimRecoverableWorkspaceRuntimes").mockImplementation(
        async (_limit, excluded = []) =>
          excluded.includes(id)
            ? []
            : [
                {
                  activationId: id,
                  runtimeCapsule: "review-capsule",
                  sandboxProfileKey: "starter",
                  workspace: assignment,
                },
              ],
      );
    }
    if (stage === "bindings")
      vi.spyOn(bindings, "adopt").mockRejectedValueOnce(
        new Error("transient binding read failure"),
      );
    else if (kind === "development")
      vi.spyOn(state, "setDevelopmentEnvironmentState").mockRejectedValueOnce(
        new Error("transient state write failure"),
      );
    else
      vi.spyOn(state, "setWorkspaceRuntimeState").mockRejectedValueOnce(
        new Error("transient state write failure"),
      );
    const controller = new SandboxController({
      provider,
      stateRepository: state,
      bindings,
      ownerBaseUrl: "http://review.test",
      imageRevision: "development",
    });
    try {
      expect(await controller.recoverPersistentDevelopmentEnvironments()).toBe(0);
      expect(attached).toBe(false);
      expect(controller.activeCount).toBe(0);
      expect(controller.recordRuntimeEvidence(tenantId, id, Date.now())).toBe(false);
      expect(await controller.recoverPersistentDevelopmentEnvironments()).toBe(1);
      expect(provider.adoptPersistentCapsule).toHaveBeenCalledTimes(2);
      expect(attached).toBe(true);
      expect(controller.activeCount).toBe(1);
      expect(controller.recordRuntimeEvidence(tenantId, id, Date.now())).toBe(true);
    } finally {
      await controller.close();
    }
  },
);
