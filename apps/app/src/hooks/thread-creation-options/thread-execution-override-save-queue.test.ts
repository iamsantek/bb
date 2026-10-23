import { describe, expect, it } from "vitest";
import {
  acknowledgeThreadExecutionOverride,
  enqueueThreadExecutionOverrideSave,
  getPendingThreadExecutionOverride,
} from "./thread-execution-override-save-queue.js";

describe("thread execution override save queue", () => {
  it("serializes rapid changes per thread without blocking another thread", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = enqueueThreadExecutionOverrideSave(
      "thread-a",
      { serviceTier: "fast" },
      async () => {
        order.push("thread-a:first-started");
        markFirstStarted();
        await firstGate;
        order.push("thread-a:first-finished");
      },
    );
    const second = enqueueThreadExecutionOverrideSave(
      "thread-a",
      { serviceTier: "default" },
      async () => {
        order.push("thread-a:second");
      },
    );
    const independent = enqueueThreadExecutionOverrideSave(
      "thread-b",
      { serviceTier: "fast" },
      async () => {
        order.push("thread-b:first");
      },
    );

    try {
      expect(getPendingThreadExecutionOverride("thread-a")).toEqual({
        serviceTier: "default",
      });

      await Promise.all([firstStarted, independent]);
      expect(order).toEqual(["thread-a:first-started", "thread-b:first"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual([
        "thread-a:first-started",
        "thread-b:first",
        "thread-a:first-finished",
        "thread-a:second",
      ]);
      expect(getPendingThreadExecutionOverride("thread-a")).toBeNull();
      expect(getPendingThreadExecutionOverride("thread-b")).toBeNull();
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second, independent]);
    }
  });

  it("continues saving the latest choice after an earlier save rejects", async () => {
    const order: string[] = [];
    let releaseNext!: () => void;
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    let markNextStarted!: () => void;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    const rejected = enqueueThreadExecutionOverrideSave(
      "thread-c",
      { model: "failed-model" },
      async () => {
        order.push("thread-c:failed");
        throw new Error("save failed");
      },
    );
    const next = enqueueThreadExecutionOverrideSave(
      "thread-c",
      { model: "latest-model" },
      async () => {
        order.push("thread-c:next");
        markNextStarted();
        await nextGate;
      },
    );

    try {
      await expect(rejected).rejects.toThrow("save failed");
      await nextStarted;
      expect(getPendingThreadExecutionOverride("thread-c")).toEqual({
        model: "latest-model",
      });
      releaseNext();
      await next;
      expect(order).toEqual(["thread-c:failed", "thread-c:next"]);
      expect(getPendingThreadExecutionOverride("thread-c")).toBeNull();
    } finally {
      releaseNext();
      await Promise.allSettled([rejected, next]);
    }
  });

  it("removes a failed field while a disjoint save is still pending", async () => {
    let rejectModelSave!: (error: Error) => void;
    const modelSave = new Promise<void>((_resolve, reject) => {
      rejectModelSave = reject;
    });
    void modelSave.catch(() => undefined);
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    let releaseTierSave!: () => void;
    const tierGate = new Promise<void>((resolve) => {
      releaseTierSave = resolve;
    });
    let markTierStarted!: () => void;
    const tierStarted = new Promise<void>((resolve) => {
      markTierStarted = resolve;
    });
    const failedModel = enqueueThreadExecutionOverrideSave(
      "thread-d",
      { model: "failed-model", reasoningLevel: "high" },
      () => {
        markModelStarted();
        return modelSave;
      },
    );
    void failedModel.catch(() => undefined);
    const pendingTier = enqueueThreadExecutionOverrideSave(
      "thread-d",
      { serviceTier: "fast" },
      async () => {
        markTierStarted();
        await tierGate;
      },
    );

    let modelSaveRejected = false;
    try {
      expect(getPendingThreadExecutionOverride("thread-d")).toEqual({
        model: "failed-model",
        reasoningLevel: "high",
        serviceTier: "fast",
      });

      await modelStarted;
      const failedModelAssertion = expect(failedModel).rejects.toThrow(
        "model save failed",
      );
      rejectModelSave(new Error("model save failed"));
      modelSaveRejected = true;
      await failedModelAssertion;
      await tierStarted;
      expect(getPendingThreadExecutionOverride("thread-d")).toEqual({
        serviceTier: "fast",
      });

      releaseTierSave();
      await pendingTier;
      expect(getPendingThreadExecutionOverride("thread-d")).toBeNull();
    } finally {
      if (!modelSaveRejected) rejectModelSave(new Error("cleanup model save"));
      releaseTierSave();
      await Promise.allSettled([failedModel, pendingTier]);
    }
  });

  it("retains a successful choice until newer canonical defaults arrive", async () => {
    const canonicalReadVersion = 8;
    const canonical = {
      model: "saved-model",
      serviceTier: "fast" as const,
      reasoningLevel: "high" as const,
      permissionMode: "full" as const,
      source: "client/turn/start" as const,
    };
    await enqueueThreadExecutionOverrideSave(
      "thread-e",
      { model: "saved-model" },
      async () => undefined,
      {
        retainUntilCanonical: true,
        getCanonicalReadVersion: () => canonicalReadVersion,
      },
    );

    expect(getPendingThreadExecutionOverride("thread-e")).toEqual({
      model: "saved-model",
    });
    acknowledgeThreadExecutionOverride(
      "thread-e",
      canonical,
      canonicalReadVersion,
    );
    expect(getPendingThreadExecutionOverride("thread-e")).toEqual({
      model: "saved-model",
    });
    acknowledgeThreadExecutionOverride(
      "thread-e",
      canonical,
      canonicalReadVersion + 1,
    );
    expect(getPendingThreadExecutionOverride("thread-e")).toBeNull();
  });
});
