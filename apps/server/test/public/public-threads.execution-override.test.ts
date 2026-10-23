import { describe, expect, it } from "vitest";
import {
  getThreadExecutionOverride,
  setThreadExecutionOverride,
} from "@bb/db";
import { resolvedThreadExecutionOptionsSchema } from "@bb/domain";
import {
  registerHostRpcResponder,
  registerProviderHostRpcResponder,
} from "../helpers/host-rpc.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function stubProviderCatalog(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
  providerId: string,
  model: string,
  additionalModels: readonly string[] = [],
): void {
  registerProviderHostRpcResponder(harness, {
    hostId,
    sessionId,
    modelsByProviderId: {
      [providerId]: {
        models: [model, ...additionalModels].map((model) => ({
          id: model,
          model,
          displayName: model,
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
            { reasoningEffort: "xhigh", description: "" },
            { reasoningEffort: "max", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        })),
        selectedOnlyModels: [],
      },
    },
  });
}

function seedProviderThread(
  harness: TestAppHarness,
  providerId = "claude-code",
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-override-${providerId}`,
  });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
  });
  return { host, session, thread };
}

function patchThread(harness: TestAppHarness, threadId: string, body: unknown) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readDefaultExecutionOptions(
  harness: TestAppHarness,
  threadId: string,
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/default-execution-options`,
  );
  expect(response.status).toBe(200);
  return resolvedThreadExecutionOptionsSchema.parse(await response.json());
}

describe("PATCH /threads/:id execution override", () => {
  for (const provider of [
    { id: "codex", model: "gpt-5.6-sol" },
    { id: "claude-code", model: "claude-opus-4-8" },
    { id: "pi", model: "openai/gpt-5.4" },
    { id: "acp-cursor", model: "gpt-5.3-codex" },
  ]) {
    it(`persists a catalog-scoped model + reasoning override for ${provider.id}`, async () => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedProviderThread(
          harness,
          provider.id,
        );
        stubProviderCatalog(
          harness,
          host.id,
          session.id,
          provider.id,
          provider.model,
        );

        const response = await patchThread(harness, thread.id, {
          model: provider.model,
          reasoningLevel: "high",
        });

        expect(response.status).toBe(200);
        expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
          modelOverride: provider.model,
          reasoningLevelOverride: "high",
          serviceTierOverride: null,
        });
      });
    });
  }

  it("rejects a model that is not in the provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-4-8",
      );

      const response = await patchThread(harness, thread.id, {
        model: "gpt-5",
      });

      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(JSON.stringify(body)).toContain(
        "not available in this thread's claude-code model catalog",
      );
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
        serviceTierOverride: null,
      });
    });
  });

  it("keeps model, reasoning, and service-tier choices per thread across reloads", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread: threadA } = seedProviderThread(
        harness,
        "codex",
      );
      const threadB = seedThread(harness.deps, {
        projectId: threadA.projectId,
        environmentId: threadA.environmentId,
        providerId: threadA.providerId,
      });
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        threadA.providerId,
        "gpt-5.6-sol",
        ["gpt-6-pro"],
      );

      const responseA = await patchThread(harness, threadA.id, {
        model: "gpt-6-pro",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
      expect(responseA.status).toBe(200);

      const responseB = await patchThread(harness, threadB.id, {
        model: "gpt-5.6-sol",
        reasoningLevel: "medium",
        serviceTier: "default",
      });
      expect(responseB.status).toBe(200);

      const reloadedA = await readDefaultExecutionOptions(harness, threadA.id);
      expect(reloadedA).toMatchObject({
        model: "gpt-6-pro",
        reasoningLevel: "high",
        serviceTier: "fast",
      });

      const reloadedB = await readDefaultExecutionOptions(harness, threadB.id);
      expect(reloadedB).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningLevel: "medium",
        serviceTier: "default",
      });

      const fastOff = await patchThread(harness, threadA.id, {
        serviceTier: "default",
      });
      expect(fastOff.status).toBe(200);
      await expect(readDefaultExecutionOptions(harness, threadA.id)).resolves
        .toMatchObject({ serviceTier: "default" });
    });
  });

  it("validates Fast support and saves service tiers without loading the catalog", async () => {
    await withTestHarness(async (harness) => {
      const {
        host: codexHost,
        session: codexSession,
        thread: codexThread,
      } = seedProviderThread(harness, "codex");
      const codexResponder = registerProviderHostRpcResponder(harness, {
        hostId: codexHost.id,
        sessionId: codexSession.id,
      });
      const fastOn = await patchThread(harness, codexThread.id, {
        serviceTier: "fast",
      });
      expect(fastOn.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, codexThread.id))
        .toMatchObject({ serviceTierOverride: "fast" });

      const fastOff = await patchThread(harness, codexThread.id, {
        serviceTier: "default",
      });
      expect(fastOff.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, codexThread.id))
        .toMatchObject({ serviceTierOverride: "default" });

      const {
        host: piHost,
        session: piSession,
        thread: piThread,
      } = seedProviderThread(harness, "pi");
      const piResponder = registerProviderHostRpcResponder(harness, {
        hostId: piHost.id,
        sessionId: piSession.id,
      });
      const unsupportedFast = await patchThread(harness, piThread.id, {
        serviceTier: "fast",
      });
      expect(unsupportedFast.status).toBe(400);
      expect(JSON.stringify(await readJson(unsupportedFast))).toContain(
        "does not support the Fast service tier",
      );
      expect(getThreadExecutionOverride(harness.db, piThread.id))
        .toMatchObject({ serviceTierOverride: null });
      expect(codexResponder.requests).toHaveLength(0);
      expect(piResponder.requests).toHaveLength(0);
      codexResponder.unregister();
      piResponder.unregister();
    });
  });

  it("preserves a concurrent Fast update while model validation is pending", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness, "codex");
      let markCatalogRequested!: () => void;
      const catalogRequested = new Promise<void>((resolve) => {
        markCatalogRequested = resolve;
      });
      let releaseCatalog!: () => void;
      const catalogGate = new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async (request) => {
          if (request.command.type !== "provider.list_models") {
            throw new Error(`Unexpected RPC ${request.command.type}`);
          }
          markCatalogRequested();
          await catalogGate;
          return {
            ok: true,
            result: {
              models: [
                availableModelFixture({
                  model: "gpt-5.6-sol",
                  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                  defaultReasoningLevel: "medium",
                }),
              ],
              selectedOnlyModels: [],
            },
          };
        },
      });

      const modelUpdate = patchThread(harness, thread.id, {
        model: "gpt-5.6-sol",
      });
      await catalogRequested;
      const fastUpdate = await patchThread(harness, thread.id, {
        serviceTier: "fast",
      });
      expect(fastUpdate.status).toBe(200);
      releaseCatalog();
      const modelResponse = await modelUpdate;
      responder.unregister();

      expect(modelResponse.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "gpt-5.6-sol",
        reasoningLevelOverride: null,
        serviceTierOverride: "fast",
      });
    });
  });

  it("uses the current reasoning override after catalog validation awaits", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness, "codex");
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "gpt-5.6-sol",
        reasoningLevelOverride: "max",
      });
      let markCatalogRequested!: () => void;
      const catalogRequested = new Promise<void>((resolve) => {
        markCatalogRequested = resolve;
      });
      let releaseCatalog!: () => void;
      const catalogGate = new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async (request) => {
          if (request.command.type !== "provider.list_models") {
            throw new Error(`Unexpected RPC ${request.command.type}`);
          }
          markCatalogRequested();
          await catalogGate;
          return {
            ok: true,
            result: {
              models: [
                availableModelFixture({
                  model: "gpt-5.4-mini",
                  reasoningLevels: ["low", "medium", "high"],
                  defaultReasoningLevel: "medium",
                }),
              ],
              selectedOnlyModels: [],
            },
          };
        },
      });

      const modelUpdate = patchThread(harness, thread.id, {
        model: "gpt-5.4-mini",
      });
      await catalogRequested;
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        reasoningLevelOverride: "low",
      });
      releaseCatalog();
      const response = await modelUpdate;
      responder.unregister();

      expect(response.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "gpt-5.4-mini",
        reasoningLevelOverride: "low",
        serviceTierOverride: null,
      });
    });
  });
});
