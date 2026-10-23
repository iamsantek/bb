// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { buildAutoFollowUpRequest } from "@bb/client-core";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderStatesResponse,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import type {
  ProviderModelCatalogScope,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  hostsQueryKey,
  systemProvidersQueryKey,
  threadDefaultExecutionOptionsQueryKey,
} from "./queries/query-keys";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { getPendingThreadExecutionOverride } from "./thread-creation-options/thread-execution-override-save-queue";
import { useThreadCreationOptions } from "./useThreadCreationOptions";
import { useThreadDefaultExecutionOptions } from "./queries/thread-default-execution-options-query";
import {
  readCachedThreadExecutionOptions,
  threadExecutionOptionsCacheKey,
  writeCachedThreadExecutionOptions,
} from "@/lib/thread-execution-options-cache";
import {
  providerListCacheKey,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";

const PROJECT_ID = "proj_prompt_defaults";
const GLOBAL_PROVIDER_ID = "global-provider";
const PROJECT_PROVIDER_ID = "project-provider";

const mocks = vi.hoisted(() => ({
  updateThreadMutateAsync: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      list: vi.fn(),
    },
    system: {
      config: vi.fn(),
      executionOptions: vi.fn(),
      providerStates: vi.fn(),
    },
    threads: {
      defaultExecutionOptions: vi.fn(),
      update: mocks.updateThreadMutateAsync,
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useHostListRealtimeSubscription: vi.fn(),
  useSystemRealtimeSubscription: vi.fn(),
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

function readyProviderStates(providerId: string): SystemProviderStatesResponse {
  return {
    providers: [
      {
        providerId,
        displayName: providerId,
        status: "ready",
        statusMessage: null,
        planLabel: null,
        accountEmail: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    ],
  };
}

function seedDeclaredCatalogScope(
  queryClient: QueryClient,
  providerId: string,
  modelCatalogScope: ProviderModelCatalogScope,
): void {
  const template = executionOptionsResponse().providers[0];
  if (template === undefined) {
    throw new Error("fixture has no provider to clone");
  }
  queryClient.setQueryData(
    systemProvidersQueryKey({
      capability: null,
      environmentId: null,
      hostId: null,
    }),
    [
      {
        ...template,
        id: providerId,
        capabilities: { ...template.capabilities, modelCatalogScope },
      },
    ],
  );
}

function rememberedProviders() {
  const base = executionOptionsResponse().providers;
  const template = base[0];
  if (template === undefined) {
    throw new Error("execution-options fixture has no provider");
  }
  return [
    {
      ...template,
      id: "codex",
      displayName: "Codex",
      logoUrl: "/api/v1/system/providers/codex/logo",
    },
    ...base,
  ];
}

function executionOptionsResponse(): SystemExecutionOptionsResponse {
  return {
    providers: [
      makeProviderInfo({
        id: GLOBAL_PROVIDER_ID,
        displayName: "Global Provider",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [
          { kind: "skills", trigger: "/" },
          {
            kind: "plan",
            command: { trigger: "/", name: "plan", trailingText: " " },
          },
        ],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
      makeProviderInfo({
        id: PROJECT_PROVIDER_ID,
        displayName: "Project Provider",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [{ kind: "skills", trigger: "/" }],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
    ],
    models: [
      {
        id: "global-model",
        model: "global-model",
        displayName: "Global Model",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
      {
        id: "project-model",
        model: "project-model",
        displayName: "Project Model",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  };
}

function resolvedThreadExecutionOptions(
  overrides: Partial<ResolvedThreadExecutionOptions> = {},
): ResolvedThreadExecutionOptions {
  return {
    model: "global-default",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
    source: "client/turn/start",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function useExistingThreadPromptOptions(threadId: string) {
  const defaultExecutionOptions = useThreadDefaultExecutionOptions(threadId);
  const creationOptions = useThreadCreationOptions({
    scope: "component-local",
    resetKey: threadId,
    persistToThreadId: threadId,
    initialProviderId: GLOBAL_PROVIDER_ID,
    initialModel: defaultExecutionOptions.data?.model ?? "global-default",
    initialReasoningLevel:
      defaultExecutionOptions.data?.reasoningLevel ?? "medium",
    initialServiceTier: defaultExecutionOptions.data?.serviceTier ?? "default",
  });
  return { defaultExecutionOptions, creationOptions };
}

function providerExecutionOptionsResponse(
  providerId: string | undefined,
): SystemExecutionOptionsResponse {
  const base = executionOptionsResponse();
  const isProjectProvider = providerId === PROJECT_PROVIDER_ID;
  const modelPrefix = isProjectProvider ? "project" : "global";
  return {
    ...base,
    models: [
      {
        id: `${modelPrefix}-default`,
        model: `${modelPrefix}-default`,
        displayName: `${modelPrefix} default`,
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: isProjectProvider ? "high" : "low",
        isDefault: true,
      },
      {
        id: `${modelPrefix}-remembered`,
        model: `${modelPrefix}-remembered`,
        displayName: `${modelPrefix} remembered`,
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
  };
}

function claudeExecutionOptionsResponse(): SystemExecutionOptionsResponse {
  return {
    providers: [
      makeProviderInfo({
        id: "claude-code",
        displayName: "Claude Code",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
    ],
    models: [
      {
        id: "claude-opus-4-8[1m]",
        model: "claude-opus-4-8[1m]",
        displayName: "Opus 4.8 (1M)",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
      {
        id: "claude-sonnet-5",
        model: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  };
}

function claudeThreadCreationArgs(resetKey: string, initialModel: string) {
  return {
    scope: "component-local" as const,
    resetKey,
    initialProviderId: "claude-code",
    initialModel,
    initialReasoningLevel: "high" as const,
    initialPermissionMode: "full" as const,
  };
}

function setProjectScopedValue(baseKey: string, value: string): void {
  window.localStorage.setItem(
    getProjectScopedStorageKey(baseKey, PROJECT_ID),
    value,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.mocked(sdk.hosts.list).mockResolvedValue([]);
  vi.mocked(sdk.system.config).mockResolvedValue(makeSystemConfig());
  mocks.updateThreadMutateAsync.mockResolvedValue(makeThreadResponse());
  vi.mocked(sdk.system.executionOptions).mockResolvedValue(
    executionOptionsResponse(),
  );
  vi.mocked(sdk.system.providerStates).mockResolvedValue({ providers: [] });
  vi.mocked(sdk.threads.defaultExecutionOptions).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("useThreadCreationOptions", () => {
  it("persists model, reasoning, and Fast choices by explicit thread owner", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    type SavedExecutionOptions = {
      model?: string;
      reasoningLevel?: "medium" | "high";
      serviceTier?: "default" | "fast";
    };
    const saved = new Map<string, SavedExecutionOptions>();
    mocks.updateThreadMutateAsync.mockImplementation(
      async ({
        threadId,
        ...patch
      }: { threadId: string } & SavedExecutionOptions) => {
        saved.set(threadId, { ...saved.get(threadId), ...patch });
      },
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) => {
        const execution = saved.get(threadId);
        return useThreadCreationOptions({
          scope: "component-local",
          resetKey: threadId,
          persistToThreadId: threadId,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: execution?.model ?? "global-default",
          initialReasoningLevel: execution?.reasoningLevel ?? "medium",
          initialServiceTier: execution?.serviceTier ?? "default",
        });
      },
      { wrapper, initialProps: { threadId: "thread-a" } },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
    });
    await waitFor(() => {
      expect(
        result.current.modelOptions.map((option) => option.value),
      ).toContain("global-remembered");
    });
    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("high");
      result.current.setServiceTier("fast");
    });
    await waitFor(() => {
      expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(3);
      expect(saved.get("thread-a")).toEqual({
        model: "global-remembered",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
    });
    await waitFor(() => {
      expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
    });

    rerender({ threadId: "thread-b" });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.serviceTier).toBe("default");
    });
    act(() => result.current.setServiceTier("default"));
    await waitFor(() => {
      expect(mocks.updateThreadMutateAsync).toHaveBeenLastCalledWith({
        threadId: "thread-b",
        serviceTier: "default",
      });
    });
    await waitFor(() => {
      expect(getPendingThreadExecutionOverride("thread-b")).toBeNull();
    });

    rerender({ threadId: "thread-a" });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("high");
      expect(result.current.serviceTier).toBe("fast");
    });
    expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
      threadId: "thread-a",
      model: "global-remembered",
      reasoningLevel: "medium",
    });
    expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
      threadId: "thread-a",
      reasoningLevel: "high",
    });
    expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(3, {
      threadId: "thread-a",
      serviceTier: "fast",
    });
    await waitFor(() => {
      expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
    });
  });

  it("reuses the latest pending choice when returning to a thread before save completes", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const persisted = new Map<
      string,
      {
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }
    >();
    const releaseSaves: Array<() => void> = [];
    let releasedSaves = 0;
    mocks.updateThreadMutateAsync.mockImplementation(
      async ({
        threadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) =>
        new Promise((resolve) => {
          releaseSaves.push(() => {
            persisted.set(threadId, {
              ...persisted.get(threadId),
              ...patch,
            });
            resolve(makeThreadResponse());
          });
        }),
    );
    const { wrapper } = createQueryClientTestHarness();
    const useOptionsForThread = ({ threadId }: { threadId: string }) => {
      const saved = persisted.get(threadId);
      return useThreadCreationOptions({
        scope: "component-local",
        resetKey: threadId,
        persistToThreadId: threadId,
        initialProviderId: GLOBAL_PROVIDER_ID,
        initialModel: saved?.model ?? "global-default",
        initialReasoningLevel: saved?.reasoningLevel ?? "medium",
        initialServiceTier: saved?.serviceTier ?? "default",
      });
    };
    const releaseNextSave = async () => {
      await waitFor(() => {
        expect(releaseSaves.length).toBeGreaterThan(releasedSaves);
      });
      const release = releaseSaves[releasedSaves];
      releasedSaves += 1;
      await act(async () => release?.());
    };

    try {
      const first = renderHook(useOptionsForThread, {
        wrapper,
        initialProps: { threadId: "thread-a" },
      });

      await waitFor(() => {
        expect(first.result.current.selectedModel).toBe("global-default");
      });
      await waitFor(() => {
        expect(
          first.result.current.modelOptions.map((option) => option.value),
        ).toContain("global-remembered");
      });
      act(() => {
        first.result.current.setSelectedModel("global-remembered");
        first.result.current.setServiceTier("fast");
        first.result.current.setReasoningLevel("high");
      });
      await waitFor(() => expect(releaseSaves).toHaveLength(1));
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
        threadId: "thread-a",
        model: "global-remembered",
        reasoningLevel: "medium",
      });
      first.unmount();

      const otherThread = renderHook(useOptionsForThread, {
        wrapper,
        initialProps: { threadId: "thread-b" },
      });
      expect(otherThread.result.current.selectedModel).toBe("global-default");
      expect(otherThread.result.current.serviceTier).toBe("default");
      otherThread.unmount();

      const returned = renderHook(useOptionsForThread, {
        wrapper,
        initialProps: { threadId: "thread-a" },
      });
      expect(returned.result.current.selectedModel).toBe("global-remembered");
      expect(returned.result.current.reasoningLevel).toBe("high");
      expect(returned.result.current.serviceTier).toBe("fast");
      expect(returned.result.current.executionInputSources).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });

      await releaseNextSave();
      await waitFor(() => expect(releaseSaves).toHaveLength(2));
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId: "thread-a",
        serviceTier: "fast",
      });
      await releaseNextSave();
      await waitFor(() => expect(releaseSaves).toHaveLength(3));
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(3, {
        threadId: "thread-a",
        reasoningLevel: "high",
      });
      await releaseNextSave();
      await waitFor(() => {
        expect(persisted.get("thread-a")).toEqual({
          model: "global-remembered",
          reasoningLevel: "high",
          serviceTier: "fast",
        });
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
      });
    } finally {
      while (
        releasedSaves < 3 &&
        getPendingThreadExecutionOverride("thread-a") !== null
      ) {
        await releaseNextSave();
      }
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
      });
    }
  });

  it("restores persisted defaults after a same-thread execution save fails", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    mocks.updateThreadMutateAsync.mockRejectedValueOnce(
      new Error("save failed"),
    );
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thread-a",
          persistToThreadId: "thread-a",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-default",
          initialReasoningLevel: "medium",
          initialServiceTier: "default",
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.serviceTier).toBe("default");
    });
    await waitFor(() => {
      expect(
        result.current.modelOptions.map((option) => option.value),
      ).toContain("global-remembered");
    });
    act(() => result.current.setServiceTier("fast"));
    expect(result.current.serviceTier).toBe("fast");
    await waitFor(() => {
      expect(result.current.serviceTier).toBe("default");
    });
    await waitFor(() => {
      expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
    });
    expect(mocks.updateThreadMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-a",
      serviceTier: "fast",
    });
  });

  it("drops a failed model while a later Fast save remains pending", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    let rejectModelSave!: (error: Error) => void;
    const modelSave = new Promise<ReturnType<typeof makeThreadResponse>>(
      (_resolve, reject) => {
        rejectModelSave = reject;
      },
    );
    void modelSave.catch(() => undefined);
    let resolveTierSave!: (
      value: ReturnType<typeof makeThreadResponse>,
    ) => void;
    const tierSave = new Promise<ReturnType<typeof makeThreadResponse>>(
      (resolve) => {
        resolveTierSave = resolve;
      },
    );
    mocks.updateThreadMutateAsync.mockImplementation(
      ({
        threadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) => {
        if (patch.model !== undefined) {
          return modelSave;
        }
        if (patch.serviceTier !== undefined) {
          return tierSave;
        }
        throw new Error(`unexpected thread update for ${threadId}`);
      },
    );
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thread-a",
          persistToThreadId: "thread-a",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-default",
          initialReasoningLevel: "medium",
          initialServiceTier: "default",
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.serviceTier).toBe("default");
    });
    await waitFor(() => {
      expect(
        result.current.modelOptions.map((option) => option.value),
      ).toContain("global-remembered");
    });
    let modelSaveRejected = false;
    let tierSaveResolved = false;
    try {
      act(() => {
        result.current.setSelectedModel("global-remembered");
        result.current.setServiceTier("fast");
      });
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.serviceTier).toBe("fast");
      expect(getPendingThreadExecutionOverride("thread-a")).toEqual({
        model: "global-remembered",
        reasoningLevel: "medium",
        serviceTier: "fast",
      });

      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
        threadId: "thread-a",
        model: "global-remembered",
        reasoningLevel: "medium",
      });

      rejectModelSave(new Error("model save failed"));
      modelSaveRejected = true;
      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(2);
        expect(getPendingThreadExecutionOverride("thread-a")).toEqual({
          serviceTier: "fast",
        });
        expect(result.current.selectedModel).toBe("global-default");
        expect(result.current.reasoningLevel).toBe("medium");
        expect(result.current.serviceTier).toBe("fast");
      });
      expect(result.current.executionInputSources).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId: "thread-a",
        serviceTier: "fast",
      });

      await act(async () => {
        resolveTierSave(makeThreadResponse());
      });
      tierSaveResolved = true;
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
      });
    } finally {
      if (!modelSaveRejected) rejectModelSave(new Error("cleanup model save"));
      if (!tierSaveResolved) resolveTierSave(makeThreadResponse());
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
      });
    }
  });

  it("keeps a successful model when a superseding save fails", async () => {
    const threadId = "thread-saved-model-before-failure";
    const catalog = providerExecutionOptionsResponse(GLOBAL_PROVIDER_ID);
    catalog.models.push({
      id: "global-next",
      model: "global-next",
      displayName: "Global next",
      description: "",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
      defaultReasoningEffort: "medium",
      isDefault: false,
    });
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(catalog);

    const initialOptions = resolvedThreadExecutionOptions();
    const firstSavedOptions = resolvedThreadExecutionOptions({
      model: "global-remembered",
    });
    const latestSavedOptions = resolvedThreadExecutionOptions({
      model: "global-remembered",
      serviceTier: "fast",
    });
    writeCachedThreadExecutionOptions(
      threadExecutionOptionsCacheKey(threadId),
      initialOptions,
    );

    const confirmationRead = deferred<ResolvedThreadExecutionOptions | null>();
    const failureRead = deferred<ResolvedThreadExecutionOptions | null>();
    const firstModelSave = deferred<ReturnType<typeof makeThreadResponse>>();
    const secondModelSave = deferred<ReturnType<typeof makeThreadResponse>>();
    const tierSave = deferred<ReturnType<typeof makeThreadResponse>>();
    void secondModelSave.promise.catch(() => undefined);

    let defaultOptionsCalls = 0;
    let confirmationReadSignal: AbortSignal | undefined;
    let failureReadSignal: AbortSignal | undefined;
    let confirmationReadResolved = false;
    let failureReadResolved = false;
    let firstModelSaveResolved = false;
    let secondModelSaveRejected = false;
    let tierSaveResolved = false;
    let persistedOptions = initialOptions;

    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      ({ signal }) => {
        defaultOptionsCalls += 1;
        if (defaultOptionsCalls === 1) return Promise.resolve(initialOptions);
        if (defaultOptionsCalls === 2) {
          confirmationReadSignal = signal;
          return confirmationRead.promise;
        }
        if (defaultOptionsCalls === 3) {
          failureReadSignal = signal;
          return failureRead.promise;
        }
        return Promise.resolve(persistedOptions);
      },
    );
    mocks.updateThreadMutateAsync.mockImplementation(
      ({
        threadId: updatedThreadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) => {
        expect(updatedThreadId).toBe(threadId);
        if (patch.model === "global-remembered") {
          return firstModelSave.promise;
        }
        if (patch.model === "global-next") {
          return secondModelSave.promise;
        }
        if (patch.serviceTier === "fast") return tierSave.promise;
        throw new Error("unexpected thread update");
      },
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useExistingThreadPromptOptions(threadId),
      { wrapper },
    );

    const resolveConfirmationRead = () => {
      confirmationReadResolved = true;
      confirmationRead.resolve(initialOptions);
    };
    const resolveFailureRead = () => {
      failureReadResolved = true;
      failureRead.resolve(initialOptions);
    };

    try {
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toEqual(
          initialOptions,
        );
        expect(result.current.defaultExecutionOptions.isPlaceholderData).toBe(
          false,
        );
        expect(defaultOptionsCalls).toBe(1);
        expect(
          result.current.creationOptions.modelOptions.map(
            (option) => option.value,
          ),
        ).toContain("global-next");
      });

      act(() => {
        result.current.creationOptions.setSelectedModel("global-remembered");
      });
      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
        threadId,
        model: "global-remembered",
        reasoningLevel: "medium",
      });

      act(() => {
        result.current.creationOptions.setSelectedModel("global-next");
        result.current.creationOptions.setServiceTier("fast");
      });
      expect(getPendingThreadExecutionOverride(threadId)).toEqual({
        model: "global-next",
        reasoningLevel: "medium",
        serviceTier: "fast",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);

      await act(async () => {
        persistedOptions = firstSavedOptions;
        firstModelSave.resolve(makeThreadResponse());
      });
      firstModelSaveResolved = true;

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(2);
        expect(confirmationReadResolved).toBe(false);
        expect(confirmationReadSignal?.aborted).toBe(true);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(2);
        expect(result.current.defaultExecutionOptions.data).toEqual(
          firstSavedOptions,
        );
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId,
        model: "global-next",
        reasoningLevel: "medium",
      });

      await act(async () => {
        secondModelSave.reject(new Error("newer model save failed"));
        secondModelSaveRejected = true;
      });

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(3);
        expect(failureReadResolved).toBe(false);
        expect(failureReadSignal?.aborted).toBe(true);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(3);
        expect(getPendingThreadExecutionOverride(threadId)).toEqual({
          model: "global-remembered",
          reasoningLevel: "medium",
          serviceTier: "fast",
        });
        expect(result.current.defaultExecutionOptions.data).toEqual(
          firstSavedOptions,
        );
        expect(result.current.creationOptions.selectedModel).toBe(
          "global-remembered",
        );
        expect(result.current.creationOptions.reasoningLevel).toBe("medium");
        expect(result.current.creationOptions.serviceTier).toBe("fast");
      });
      expect(
        result.current.creationOptions.executionInputSources,
      ).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(3, {
        threadId,
        serviceTier: "fast",
      });

      expect(
        buildAutoFollowUpRequest({
          threadId,
          input: [{ type: "text", text: "continue", mentions: [] }],
          execution: {
            model: result.current.creationOptions.selectedModel,
            permissionMode: result.current.creationOptions.permissionMode,
            reasoningLevel: result.current.creationOptions.reasoningLevel,
            serviceTier: result.current.creationOptions.serviceTier,
            supportsServiceTier:
              result.current.creationOptions.supportsServiceTier,
            executionInputSources:
              result.current.creationOptions.executionInputSources,
          },
        }),
      ).toMatchObject({
        id: threadId,
        model: "global-remembered",
        reasoningLevel: "medium",
        serviceTier: "fast",
        executionInputSources: {
          model: "explicit",
          reasoningLevel: "explicit",
          serviceTier: "explicit",
        },
      });

      await act(async () => {
        persistedOptions = latestSavedOptions;
        tierSave.resolve(makeThreadResponse());
      });
      tierSaveResolved = true;

      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toEqual(
          latestSavedOptions,
        );
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });

      await act(async () => {
        resolveConfirmationRead();
        resolveFailureRead();
      });
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toEqual(
          latestSavedOptions,
        );
        expect(
          readCachedThreadExecutionOptions(
            threadExecutionOptionsCacheKey(threadId),
          ),
        ).toEqual(latestSavedOptions);
      });
      expect(result.current.creationOptions.selectedModel).toBe(
        "global-remembered",
      );
      expect(result.current.creationOptions.serviceTier).toBe("fast");
    } finally {
      if (!firstModelSaveResolved) {
        persistedOptions = firstSavedOptions;
        firstModelSave.resolve(makeThreadResponse());
      }
      if (!secondModelSaveRejected) {
        secondModelSave.reject(new Error("cleanup model save"));
      }
      if (!tierSaveResolved) {
        persistedOptions = latestSavedOptions;
        tierSave.resolve(makeThreadResponse());
      }
      await act(async () => {
        await queryClient.cancelQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
        });
        if (!confirmationReadResolved) resolveConfirmationRead();
        if (!failureReadResolved) resolveFailureRead();
        await queryClient.invalidateQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
          refetchType: "all",
        });
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });
    }
  });

  it("keeps a successful selection over a deferred pre-write defaults response", async () => {
    const threadId = "thread-late-defaults";
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const storedOptions = resolvedThreadExecutionOptions();
    writeCachedThreadExecutionOptions(
      threadExecutionOptionsCacheKey(threadId),
      storedOptions,
    );
    const oldDefaults = deferred<ResolvedThreadExecutionOptions | null>();
    const supersededRefresh = deferred<ResolvedThreadExecutionOptions | null>();
    const canonicalRefresh = deferred<ResolvedThreadExecutionOptions | null>();
    let oldRequestSignal: AbortSignal | undefined;
    let supersededRefreshSignal: AbortSignal | undefined;
    let canonicalRefreshSignal: AbortSignal | undefined;
    let defaultOptionsCalls = 0;
    let oldDefaultsResolved = false;
    let supersededRefreshResolved = false;
    let canonicalRefreshResolved = false;
    let persistedOptions = storedOptions;
    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      ({ signal }) => {
        defaultOptionsCalls += 1;
        if (defaultOptionsCalls === 1) {
          oldRequestSignal = signal;
          return oldDefaults.promise;
        }
        if (defaultOptionsCalls === 2) {
          supersededRefreshSignal = signal;
          return supersededRefresh.promise;
        }
        if (defaultOptionsCalls === 3) {
          canonicalRefreshSignal = signal;
          return canonicalRefresh.promise;
        }
        return Promise.resolve(persistedOptions);
      },
    );
    mocks.updateThreadMutateAsync.mockImplementation(
      async ({
        threadId: updatedThreadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) => {
        expect(updatedThreadId).toBe(threadId);
        persistedOptions = resolvedThreadExecutionOptions({
          ...persistedOptions,
          ...patch,
        });
        return makeThreadResponse();
      },
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useExistingThreadPromptOptions(threadId),
      { wrapper },
    );

    try {
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.isPlaceholderData).toBe(
          true,
        );
        expect(result.current.defaultExecutionOptions.data).toEqual(
          storedOptions,
        );
        expect(defaultOptionsCalls).toBe(1);
        expect(oldRequestSignal).toBeDefined();
        expect(
          result.current.creationOptions.modelOptions.map(
            (option) => option.value,
          ),
        ).toContain("global-remembered");
      });
      act(() => {
        result.current.creationOptions.setSelectedModel("global-remembered");
        result.current.creationOptions.setServiceTier("fast");
      });
      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
          threadId,
          model: "global-remembered",
          reasoningLevel: "medium",
        });
      });
      expect(oldRequestSignal?.aborted).toBe(true);

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(3);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(2);
        expect(supersededRefreshResolved).toBe(false);
        expect(supersededRefreshSignal?.aborted).toBe(true);
        expect(canonicalRefreshResolved).toBe(false);
        expect(canonicalRefreshSignal?.aborted).toBe(false);
        expect(result.current.defaultExecutionOptions.data).toEqual(
          persistedOptions,
        );
        expect(getPendingThreadExecutionOverride(threadId)).toEqual({
          model: "global-remembered",
          reasoningLevel: "medium",
          serviceTier: "fast",
        });
        expect(result.current.creationOptions.selectedModel).toBe(
          "global-remembered",
        );
        expect(result.current.creationOptions.reasoningLevel).toBe("medium");
        expect(result.current.creationOptions.serviceTier).toBe("fast");
        expect(
          result.current.creationOptions.executionInputSources,
        ).toMatchObject({
          model: "explicit",
          reasoningLevel: "explicit",
          serviceTier: "explicit",
        });
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId,
        serviceTier: "fast",
      });

      await act(async () => {
        canonicalRefreshResolved = true;
        canonicalRefresh.resolve(persistedOptions);
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });

      await act(async () => {
        oldDefaultsResolved = true;
        oldDefaults.resolve(storedOptions);
        supersededRefreshResolved = true;
        supersededRefresh.resolve(storedOptions);
      });
      expect(result.current.defaultExecutionOptions.data).toEqual(
        persistedOptions,
      );
      expect(result.current.creationOptions.selectedModel).toBe(
        "global-remembered",
      );
      expect(result.current.creationOptions.reasoningLevel).toBe("medium");
      expect(result.current.creationOptions.serviceTier).toBe("fast");
      expect(
        result.current.creationOptions.executionInputSources,
      ).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });
      expect(
        readCachedThreadExecutionOptions(
          threadExecutionOptionsCacheKey(threadId),
        ),
      ).toEqual(persistedOptions);
    } finally {
      await act(async () => {
        await queryClient.cancelQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
        });
        if (!oldDefaultsResolved) {
          oldDefaultsResolved = true;
          oldDefaults.resolve(storedOptions);
        }
        if (!supersededRefreshResolved) {
          supersededRefreshResolved = true;
          supersededRefresh.resolve(storedOptions);
        }
        if (!canonicalRefreshResolved) {
          canonicalRefreshResolved = true;
          canonicalRefresh.resolve(persistedOptions);
        }
        await queryClient.invalidateQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
          refetchType: "all",
        });
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });
    }
  });

  it("retains a successful partial model when defaults have no cached tuple", async () => {
    const threadId = "thread-no-cached-execution-defaults";
    const catalog = providerExecutionOptionsResponse(GLOBAL_PROVIDER_ID);
    catalog.models.push({
      id: "global-next",
      model: "global-next",
      displayName: "Global next",
      description: "",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
      defaultReasoningEffort: "medium",
      isDefault: false,
    });
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(catalog);

    const initialOptions = resolvedThreadExecutionOptions();
    const firstSavedOptions = resolvedThreadExecutionOptions({
      model: "global-remembered",
    });
    const latestSavedOptions = resolvedThreadExecutionOptions({
      model: "global-remembered",
      serviceTier: "fast",
    });
    const initialRead = deferred<ResolvedThreadExecutionOptions | null>();
    const confirmationRead = deferred<ResolvedThreadExecutionOptions | null>();
    const failureRead = deferred<ResolvedThreadExecutionOptions | null>();
    const firstModelSave = deferred<ReturnType<typeof makeThreadResponse>>();
    const secondModelSave = deferred<ReturnType<typeof makeThreadResponse>>();
    const tierSave = deferred<ReturnType<typeof makeThreadResponse>>();
    void secondModelSave.promise.catch(() => undefined);

    let defaultOptionsCalls = 0;
    let initialReadSignal: AbortSignal | undefined;
    let confirmationReadSignal: AbortSignal | undefined;
    let failureReadSignal: AbortSignal | undefined;
    let initialReadResolved = false;
    let confirmationReadResolved = false;
    let failureReadResolved = false;
    let firstModelSaveResolved = false;
    let secondModelSaveRejected = false;
    let tierSaveResolved = false;
    let persistedOptions = initialOptions;

    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      ({ signal }) => {
        defaultOptionsCalls += 1;
        if (defaultOptionsCalls === 1) {
          initialReadSignal = signal;
          return initialRead.promise;
        }
        if (defaultOptionsCalls === 2) {
          confirmationReadSignal = signal;
          return confirmationRead.promise;
        }
        if (defaultOptionsCalls === 3) {
          failureReadSignal = signal;
          return failureRead.promise;
        }
        return Promise.resolve(persistedOptions);
      },
    );
    mocks.updateThreadMutateAsync.mockImplementation(
      ({
        threadId: updatedThreadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) => {
        expect(updatedThreadId).toBe(threadId);
        if (patch.model === "global-remembered") {
          return firstModelSave.promise;
        }
        if (patch.model === "global-next") {
          return secondModelSave.promise;
        }
        if (patch.serviceTier === "fast") return tierSave.promise;
        throw new Error("unexpected thread update");
      },
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useExistingThreadPromptOptions(threadId),
      { wrapper },
    );

    const resolveInitialRead = (options: ResolvedThreadExecutionOptions) => {
      initialReadResolved = true;
      initialRead.resolve(options);
    };
    const resolveConfirmationRead = (
      options: ResolvedThreadExecutionOptions,
    ) => {
      confirmationReadResolved = true;
      confirmationRead.resolve(options);
    };
    const resolveFailureRead = (options: ResolvedThreadExecutionOptions) => {
      failureReadResolved = true;
      failureRead.resolve(options);
    };

    try {
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toBeUndefined();
        expect(result.current.defaultExecutionOptions.isPlaceholderData).toBe(
          false,
        );
        expect(defaultOptionsCalls).toBe(1);
        expect(initialReadSignal).toBeDefined();
        expect(initialReadSignal?.aborted).toBe(false);
        expect(
          result.current.creationOptions.modelOptions.map(
            (option) => option.value,
          ),
        ).toContain("global-next");
      });
      expect(
        readCachedThreadExecutionOptions(
          threadExecutionOptionsCacheKey(threadId),
        ),
      ).toBeNull();

      act(() => {
        result.current.creationOptions.setSelectedModel("global-remembered");
      });
      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(initialReadSignal?.aborted).toBe(true);
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
        threadId,
        model: "global-remembered",
        reasoningLevel: "medium",
      });

      act(() => {
        result.current.creationOptions.setSelectedModel("global-next");
        result.current.creationOptions.setServiceTier("fast");
      });
      expect(getPendingThreadExecutionOverride(threadId)).toEqual({
        model: "global-next",
        reasoningLevel: "medium",
        serviceTier: "fast",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);

      await act(async () => {
        persistedOptions = firstSavedOptions;
        firstModelSave.resolve(makeThreadResponse());
      });
      firstModelSaveResolved = true;

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(2);
        expect(confirmationReadResolved).toBe(false);
        expect(confirmationReadSignal?.aborted).toBe(true);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(2);
        expect(result.current.defaultExecutionOptions.data).toBeUndefined();
        expect(getPendingThreadExecutionOverride(threadId)).toEqual({
          model: "global-next",
          reasoningLevel: "medium",
          serviceTier: "fast",
        });
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId,
        model: "global-next",
        reasoningLevel: "medium",
      });

      await act(async () => {
        secondModelSave.reject(new Error("newer model save failed"));
        secondModelSaveRejected = true;
      });

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(3);
        expect(failureReadResolved).toBe(false);
        expect(failureReadSignal?.aborted).toBe(true);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(3);
        expect(result.current.defaultExecutionOptions.data).toBeUndefined();
        expect(getPendingThreadExecutionOverride(threadId)).toEqual({
          model: "global-remembered",
          reasoningLevel: "medium",
          serviceTier: "fast",
        });
        expect(result.current.creationOptions.selectedModel).toBe(
          "global-remembered",
        );
        expect(result.current.creationOptions.reasoningLevel).toBe("medium");
        expect(result.current.creationOptions.serviceTier).toBe("fast");
      });
      expect(
        readCachedThreadExecutionOptions(
          threadExecutionOptionsCacheKey(threadId),
        ),
      ).toBeNull();
      expect(
        result.current.creationOptions.executionInputSources,
      ).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(3, {
        threadId,
        serviceTier: "fast",
      });

      expect(
        buildAutoFollowUpRequest({
          threadId,
          input: [{ type: "text", text: "continue", mentions: [] }],
          execution: {
            model: result.current.creationOptions.selectedModel,
            permissionMode: result.current.creationOptions.permissionMode,
            reasoningLevel: result.current.creationOptions.reasoningLevel,
            serviceTier: result.current.creationOptions.serviceTier,
            supportsServiceTier:
              result.current.creationOptions.supportsServiceTier,
            executionInputSources:
              result.current.creationOptions.executionInputSources,
          },
        }),
      ).toMatchObject({
        id: threadId,
        model: "global-remembered",
        reasoningLevel: "medium",
        serviceTier: "fast",
        executionInputSources: {
          model: "explicit",
          reasoningLevel: "explicit",
          serviceTier: "explicit",
        },
      });

      await act(async () => {
        persistedOptions = latestSavedOptions;
        tierSave.resolve(makeThreadResponse());
      });
      tierSaveResolved = true;

      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(4);
        expect(result.current.defaultExecutionOptions.data).toEqual(
          latestSavedOptions,
        );
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });

      await act(async () => {
        resolveInitialRead(initialOptions);
        resolveConfirmationRead(initialOptions);
        resolveFailureRead(initialOptions);
      });
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toEqual(
          latestSavedOptions,
        );
        expect(
          readCachedThreadExecutionOptions(
            threadExecutionOptionsCacheKey(threadId),
          ),
        ).toEqual(latestSavedOptions);
      });
    } finally {
      if (!firstModelSaveResolved) {
        persistedOptions = firstSavedOptions;
        firstModelSave.resolve(makeThreadResponse());
      }
      if (!secondModelSaveRejected) {
        secondModelSave.reject(new Error("cleanup model save"));
      }
      if (!tierSaveResolved) {
        persistedOptions = latestSavedOptions;
        tierSave.resolve(makeThreadResponse());
      }
      await act(async () => {
        await queryClient.cancelQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
        });
        if (!initialReadResolved) resolveInitialRead(initialOptions);
        if (!confirmationReadResolved) {
          resolveConfirmationRead(persistedOptions);
        }
        if (!failureReadResolved) resolveFailureRead(persistedOptions);
        await queryClient.invalidateQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
          refetchType: "all",
        });
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });
    }
  });

  it("settles a failed save before its held defaults refresh", async () => {
    const threadId = "thread-held-failure-refresh";
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const storedOptions = resolvedThreadExecutionOptions();
    writeCachedThreadExecutionOptions(
      threadExecutionOptionsCacheKey(threadId),
      storedOptions,
    );
    const failedRefresh = deferred<ResolvedThreadExecutionOptions | null>();
    const modelSave = deferred<ReturnType<typeof makeThreadResponse>>();
    const tierSave = deferred<ReturnType<typeof makeThreadResponse>>();
    void modelSave.promise.catch(() => undefined);
    let failedRefreshSignal: AbortSignal | undefined;
    let failedRefreshResolved = false;
    let defaultOptionsCalls = 0;
    let persistedOptions = storedOptions;
    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      ({ signal }) => {
        defaultOptionsCalls += 1;
        if (defaultOptionsCalls === 2) {
          failedRefreshSignal = signal;
          return failedRefresh.promise;
        }
        return Promise.resolve(persistedOptions);
      },
    );
    mocks.updateThreadMutateAsync.mockImplementation(
      ({
        threadId: updatedThreadId,
        ...patch
      }: {
        threadId: string;
        model?: string;
        reasoningLevel?: "medium" | "high";
        serviceTier?: "default" | "fast";
      }) => {
        expect(updatedThreadId).toBe(threadId);
        if (patch.model !== undefined) return modelSave.promise;
        if (patch.serviceTier !== undefined) {
          persistedOptions = resolvedThreadExecutionOptions({
            ...persistedOptions,
            ...patch,
          });
          return tierSave.promise;
        }
        throw new Error("unexpected thread update");
      },
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useExistingThreadPromptOptions(threadId),
      { wrapper },
    );
    let modelSaveRejected = false;
    let tierSaveResolved = false;
    const resolveFailedRefresh = () => {
      failedRefreshResolved = true;
      failedRefresh.resolve(storedOptions);
    };

    try {
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data).toEqual(
          storedOptions,
        );
        expect(result.current.defaultExecutionOptions.isPlaceholderData).toBe(
          false,
        );
        expect(
          result.current.creationOptions.modelOptions.map(
            (option) => option.value,
          ),
        ).toContain("global-remembered");
      });
      act(() => {
        result.current.creationOptions.setSelectedModel("global-remembered");
        result.current.creationOptions.setServiceTier("fast");
      });
      await waitFor(() => {
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(1, {
        threadId,
        model: "global-remembered",
        reasoningLevel: "medium",
      });

      modelSave.reject(new Error("model save failed"));
      modelSaveRejected = true;
      await waitFor(() => {
        expect(defaultOptionsCalls).toBe(2);
        expect(mocks.updateThreadMutateAsync).toHaveBeenCalledTimes(2);
        expect(failedRefreshResolved).toBe(false);
        expect(failedRefreshSignal?.aborted).toBe(true);
        expect(getPendingThreadExecutionOverride(threadId)).toEqual({
          serviceTier: "fast",
        });
        expect(result.current.creationOptions.selectedModel).toBe(
          "global-default",
        );
        expect(result.current.creationOptions.serviceTier).toBe("fast");
      });
      expect(
        result.current.creationOptions.executionInputSources,
      ).toMatchObject({
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      });
      expect(mocks.updateThreadMutateAsync).toHaveBeenNthCalledWith(2, {
        threadId,
        serviceTier: "fast",
      });

      await act(async () => {
        tierSave.resolve(makeThreadResponse());
      });
      tierSaveResolved = true;
      await waitFor(() => {
        expect(result.current.defaultExecutionOptions.data?.serviceTier).toBe(
          "fast",
        );
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });
      expect(failedRefreshResolved).toBe(false);

      await act(async () => {
        resolveFailedRefresh();
      });
      expect(result.current.defaultExecutionOptions.data).toEqual(
        persistedOptions,
      );
      expect(
        readCachedThreadExecutionOptions(
          threadExecutionOptionsCacheKey(threadId),
        ),
      ).toEqual(persistedOptions);
    } finally {
      if (!modelSaveRejected) modelSave.reject(new Error("cleanup model save"));
      if (!tierSaveResolved) tierSave.resolve(makeThreadResponse());
      await act(async () => {
        await queryClient.cancelQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
        });
        if (!failedRefreshResolved) resolveFailedRefresh();
        await queryClient.invalidateQueries({
          queryKey: threadDefaultExecutionOptionsQueryKey(threadId),
          refetchType: "all",
        });
      });
      await waitFor(() => {
        expect(getPendingThreadExecutionOverride(threadId)).toBeNull();
      });
    }
  });

  it("keeps the selected remembered provider branded while models load", () => {
    window.localStorage.setItem("bb.promptbox.provider", "codex");
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      rememberedProviders(),
    );
    vi.mocked(sdk.system.executionOptions).mockImplementation(
      () => new Promise(() => undefined),
    );

    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    expect(result.current.isLoadingModels).toBe(true);
    expect(result.current.selectedProviderId).toBe("codex");
    expect(
      result.current.providerOptions.find((option) => option.value === "codex")
        ?.icon,
    ).toBeDefined();
  });

  it("does not switch away from a provider when its failed plugin response arrives", async () => {
    window.localStorage.setItem("bb.promptbox.provider", "codex");
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      rememberedProviders(),
    );
    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    const optionsPromise = new Promise<SystemExecutionOptionsResponse>(
      (resolve) => {
        resolveOptions = resolve;
      },
    );
    vi.mocked(sdk.system.executionOptions).mockReturnValue(optionsPromise);
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    act(() => {
      result.current.setSelectedProviderId("codex");
    });
    expect(result.current.selectedProviderId).toBe("codex");

    const base = executionOptionsResponse();
    const templateProvider = base.providers[0];
    if (templateProvider === undefined) {
      throw new Error("execution-options fixture has no provider");
    }
    act(() => {
      resolveOptions({
        ...base,
        providers: [
          {
            ...templateProvider,
            id: "codex",
            pluginId: "provider-codex",
            displayName: "Codex",
            available: false,
          },
          ...base.providers,
        ],
        models: [],
        modelLoadError: {
          providerId: "codex",
          code: "provider_unavailable",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("codex");
      expect(result.current.modelLoadError).toEqual({
        providerId: "codex",
        code: "provider_unavailable",
      });
      expect(
        result.current.providerOptions.map((option) => option.value),
      ).toContain("codex");
    });
  });

  it("uses the medium product default for providers without reasoning history", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
  });

  it("persists the reconciled reasoning level when switching to a shorter model ladder", async () => {
    const response = executionOptionsResponse();
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...response,
      models: [
        {
          id: "wide-model",
          model: "wide-model",
          displayName: "Wide Model",
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
        },
        {
          id: "short-model",
          model: "short-model",
          displayName: "Short Model",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ],
    });
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "wide-model",
          initialReasoningLevel: "max",
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("wide-model");
      expect(result.current.reasoningLevel).toBe("max");
    });

    act(() => {
      result.current.setSelectedModel("short-model");
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("short-model");
      expect(result.current.reasoningLevel).toBe("high");
      expect(result.current.executionInputSources.reasoningLevel).toBe(
        "client-preference",
      );
    });

    act(() => {
      result.current.setSelectedModel("wide-model");
    });

    await waitFor(() => {
      expect(result.current.reasoningLevel).toBe("high");
    });
  });

  it("applies a fork provider, model, and reasoning seed atomically", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
    });
    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setProviderModelReasoning({
        providerId: PROJECT_PROVIDER_ID,
        model: "project-remembered",
        reasoningLevel: "high",
      });
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("high");
    });

    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("high");
    });
  });

  it("migrates legacy model preferences without leaking them to another provider", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    window.localStorage.setItem("bb.promptbox.model", "global-remembered");
    window.localStorage.setItem("bb.promptbox.reasoning", "medium");
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    expect(window.localStorage.getItem("bb.promptbox.model")).toBeNull();

    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });
  });

  it("restores each provider's model and reasoning selection", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedModel("project-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    unmount();
    const reloaded = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    await waitFor(() => {
      expect(reloaded.result.current.selectedProviderId).toBe(
        PROJECT_PROVIDER_ID,
      );
      expect(reloaded.result.current.selectedModel).toBe("project-remembered");
      expect(reloaded.result.current.reasoningLevel).toBe("medium");
    });
    act(() => {
      reloaded.result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(reloaded.result.current.selectedModel).toBe("global-remembered");
      expect(reloaded.result.current.reasoningLevel).toBe("medium");
    });
  });

  it("refreshes untouched Fast defaults but preserves an unsent choice until thread reset", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ tier, threadId }: { tier: "fast" | "default"; threadId: string }) =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: threadId,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
          initialServiceTier: tier,
        }),
      { wrapper, initialProps: { tier: "fast", threadId: "thr_one" } },
    );
    await waitFor(() => expect(result.current.serviceTier).toBe("fast"));
    rerender({ tier: "default", threadId: "thr_one" });
    expect(result.current.serviceTier).toBe("default");
    act(() => result.current.setServiceTier("fast"));
    rerender({ tier: "fast", threadId: "thr_one" });
    rerender({ tier: "default", threadId: "thr_one" });
    expect(result.current.serviceTier).toBe("fast");
    rerender({ tier: "default", threadId: "thr_two" });
    expect(result.current.serviceTier).toBe("default");
  });

  it("keeps provider selections local in component-local composers", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          initialProviderId: GLOBAL_PROVIDER_ID,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
    });
    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    act(() => {
      result.current.setSelectedModel("project-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    expect(window.localStorage.getItem("bb.promptbox.model")).toBeNull();
  });

  it("preserves a model's nested provider route for the picker", async () => {
    const response = executionOptionsResponse();
    const firstModel = response.models[0];
    if (!firstModel) throw new Error("Expected a model fixture");
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...response,
      models: [
        { ...firstModel, routeProviderId: "openai-codex" },
        ...response.models.slice(1),
      ],
    });
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.modelOptions[0]).toEqual({
        value: "global-model",
        label: "Global Model",
        routeProviderId: "openai-codex",
      });
    });
  });

  it("routes root-composer provider discovery through the selected project host", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    window.localStorage.setItem("bb.promptbox.model", "global-model");
    window.localStorage.setItem("bb.promptbox.service-tier", "default");
    window.localStorage.setItem("bb.promptbox.reasoning", "high");
    window.localStorage.setItem(
      "bb.promptbox.permission-mode",
      "workspace-write",
    );
    window.localStorage.setItem(
      "bb.promptbox.environment",
      "host:global-host:worktree",
    );

    setProjectScopedValue("bb.promptbox.provider", PROJECT_PROVIDER_ID);
    setProjectScopedValue("bb.promptbox.model", "project-model");
    setProjectScopedValue("bb.promptbox.service-tier", "fast");
    setProjectScopedValue("bb.promptbox.reasoning", "low");
    setProjectScopedValue("bb.promptbox.permission-mode", "readonly");
    setProjectScopedValue(
      "bb.promptbox.environment",
      "host:project-host:local",
    );

    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          resolveProviderRouting: (value) =>
            value === "provider:project-checkout"
              ? { hostId: "project-host" }
              : {},
          initialProviderId: "initial-provider",
          initialModel: "initial-model",
          initialServiceTier: "fast",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "provider:git-worktree",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "project-host",
          providerId: GLOBAL_PROVIDER_ID,
        }),
      );
      expect(sdk.system.executionOptions).not.toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "project-host",
          providerId: PROJECT_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(GLOBAL_PROVIDER_ID);
      expect(result.current.selectedProviderComposerActions).toEqual([
        { kind: "skills", trigger: "/" },
        {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        },
      ]);
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.serviceTier).toBe("default");
      expect(result.current.reasoningLevel).toBe("high");
      expect(result.current.permissionMode).toBe("accept-edits");
      expect(result.current.environmentSelectionValue).toBe(
        "provider:project-checkout",
      );
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "project-host",
      });
    });
  });

  it("disables permission modes above the machine's permission limit", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...executionOptionsResponse(),
      permissionCeiling: "auto",
    });
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "host:capped-host:local",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(
        result.current.permissionModeOptions.map((option) => [
          option.value,
          option.disabled ?? false,
        ]),
      ).toEqual([
        ["accept-edits", false],
        ["auto", false],
        ["full", true],
      ]);
      expect(result.current.permissionMode).toBe("auto");
    });
    expect(
      result.current.permissionModeOptions.find(
        (option) => option.value === "full",
      )?.disabledReason,
    ).toContain("permission limit");
  });

  it("uses the cached machine limit before the routed answer lands", async () => {
    let resolveExecutionOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void;
    vi.mocked(sdk.system.executionOptions).mockReturnValue(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveExecutionOptions = resolve;
      }),
    );
    const { wrapper, queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(hostsQueryKey(), [
      {
        id: "capped-host",
        name: "capped",
        type: "persistent",
        status: "connected",
        maxPermissionMode: "accept-edits",
        lastSeenAt: null,
        lastRejectedProtocolVersion: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "host:capped-host:local",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(
        result.current.permissionModeOptions.find(
          (option) => option.value === "full",
        )?.disabled,
      ).toBe(true);
    });
    resolveExecutionOptions!(executionOptionsResponse());
  });

  it("persists new-thread environment selection under the project key", () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
        }),
      { wrapper },
    );

    act(() => {
      result.current.setEnvironmentSelectionValue("host:project-host:worktree");
    });

    expect(window.localStorage.getItem("bb.promptbox.environment")).toBeNull();
    expect(
      window.localStorage.getItem(
        getProjectScopedStorageKey("bb.promptbox.environment", PROJECT_ID),
      ),
    ).toBe("host:project-host:worktree");
  });

  it("migrates a stored legacy worktree selection to the worktree provider", () => {
    const { wrapper } = createQueryClientTestHarness();
    window.localStorage.setItem(
      getProjectScopedStorageKey("bb.promptbox.environment", PROJECT_ID),
      "host:project-host:worktree",
    );

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
        }),
      { wrapper },
    );

    expect(result.current.environmentSelectionValue).toBe(
      "provider:git-worktree",
    );
  });

  it("routes a host-scoped component-local catalog by the environment's host", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    seedDeclaredCatalogScope(queryClient, "claude-code", "host");

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_host_scoped",
          initialProviderId: "claude-code",
          initialModel: "claude-opus-5",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "host_follow_up",
          providerId: "claude-code",
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "host_follow_up",
      });
    });
  });

  it("re-routes to the host once the first probe's own roster declares host scope", async () => {
    const hostScoped = executionOptionsResponse();
    const [provider] = hostScoped.providers;
    if (provider === undefined) throw new Error("fixture has no provider");
    provider.capabilities = {
      ...provider.capabilities,
      modelCatalogScope: "host",
    };
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(hostScoped);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_cold_cache",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "model-a",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: "env_follow_up" }),
      );
    });
    await waitFor(() => {
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "host_follow_up",
      });
    });
  });

  it("keeps a workspace-scoped component-local catalog routed by environment", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    seedDeclaredCatalogScope(queryClient, "pi", "workspace");

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_workspace_scoped",
          initialProviderId: "pi",
          initialModel: "anthropic/opus",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "env_follow_up",
          hostId: undefined,
          providerId: "pi",
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        environmentId: "env_follow_up",
      });
    });
  });

  it("loads provider composer actions for environmentless component-local threads", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: undefined,
          resetKey: "thr_environmentless",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
          initialServiceTier: "default",
          initialReasoningLevel: "medium",
          initialPermissionMode: "accept-edits",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          providerId: GLOBAL_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(GLOBAL_PROVIDER_ID);
      expect(result.current.selectedProviderComposerActions).toEqual([
        { kind: "skills", trigger: "/" },
        {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        },
      ]);
    });
  });

  it("marks a definitive missing component-local model fallback as explicit", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_stale_model",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "claude-mythos-5",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("overrides a stale project model default when creating a new thread", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "removed-project-default",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("keeps an existing model when provider discovery fails temporarily", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValueOnce({
      ...executionOptionsResponse(),
      modelLoadError: { providerId: GLOBAL_PROVIDER_ID, code: "failed" },
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_model_discovery_failure",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "still-valid-model",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.modelLoadFailed).toBe(true);
      expect(result.current.selectedModel).toBe("still-valid-model");
      expect(result.current.executionInputSources.model).toBeUndefined();
    });
  });

  it("keeps a stored model through a cold-cache probe and recovers only once it lands", async () => {
    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    vi.mocked(sdk.system.executionOptions).mockReturnValueOnce(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_claude_preload",
          initialProviderId: "claude-code",
          initialModel: "claude-mythos-5",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    expect(result.current.modelOptions).toEqual([]);
    expect(result.current.selectedModel).toBe("claude-mythos-5");
    expect(result.current.executionInputSources.model).toBeUndefined();

    act(() => {
      resolveOptions(claudeExecutionOptionsResponse());
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("claude-opus-4-8[1m]");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("preloads the account's real model ids so a preload-window pick survives", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(
      claudeExecutionOptionsResponse(),
    );

    const first = renderHook(
      () =>
        useThreadCreationOptions(
          claudeThreadCreationArgs("thr_cached_first", "claude-opus-4-8[1m]"),
        ),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    await waitFor(() => {
      expect(
        first.result.current.modelOptions.map((option) => option.value),
      ).toEqual(["claude-opus-4-8[1m]", "claude-sonnet-5"]);
    });
    first.unmount();

    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    vi.mocked(sdk.system.executionOptions).mockReturnValueOnce(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const second = renderHook(
      () =>
        useThreadCreationOptions(
          claudeThreadCreationArgs("thr_cached_second", "claude-sonnet-5"),
        ),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(
        second.result.current.modelOptions.map((option) => option.value),
      ).toEqual(["claude-opus-4-8[1m]", "claude-sonnet-5"]);
    });
    expect(second.result.current.selectedModel).toBe("claude-sonnet-5");

    act(() => {
      resolveOptions(claudeExecutionOptionsResponse());
    });

    await waitFor(() => {
      expect(second.result.current.selectedModel).toBe("claude-sonnet-5");
      expect(second.result.current.executionInputSources.model).toBeUndefined();
    });
  });

  it("lets the server resolve the catalog default when no selection exists", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useThreadCreationOptions(), { wrapper });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: undefined,
          providerId: undefined,
        }),
      );
    });
  });

  it("latches the initial ready provider instead of resolving it again after a machine switch", async () => {
    window.localStorage.setItem(
      "bb.promptbox.environment",
      "provider:project-checkout",
    );
    vi.mocked(sdk.system.providerStates).mockImplementation(async (args) =>
      args?.hostId === "remote-host"
        ? readyProviderStates(PROJECT_PROVIDER_ID)
        : readyProviderStates(GLOBAL_PROVIDER_ID),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferReadyProviderWhenUnset: true,
          resolveProviderRouting: (value) =>
            value === "provider:project-checkout"
              ? { hostId: "remote-host" }
              : value === "provider:git-worktree"
                ? { hostId: "second-host" }
                : {},
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.providerStates).toHaveBeenCalledWith({
        environmentId: undefined,
        hostId: "remote-host",
        signal: expect.any(AbortSignal),
      });
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.executionInputSources).toMatchObject({
        providerId: "client-preference",
      });
      expect(result.current.executionInputSources.model).toBeUndefined();
    });
    const initialDiscoveryCallCount = vi.mocked(sdk.system.providerStates).mock
      .calls.length;

    act(() => {
      result.current.setEnvironmentSelectionValue("provider:git-worktree");
    });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "second-host",
          providerId: PROJECT_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
    });
    expect(sdk.system.providerStates).toHaveBeenCalledTimes(
      initialDiscoveryCallCount,
    );
    expect(sdk.system.providerStates).not.toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "second-host" }),
    );
  });

  it("routes reusable root-composer worktrees through their environment", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
        }),
      { wrapper },
    );

    act(() => {
      result.current.setEnvironmentSelectionValue("reuse:env-remote");
    });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "env-remote",
          hostId: undefined,
          providerId: undefined,
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        environmentId: "env-remote",
      });
    });
  });
});
