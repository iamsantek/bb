import { describe, expect, it } from "vitest";
import {
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

    await expect(rejected).rejects.toThrow("save failed");
    await nextStarted;
    expect(getPendingThreadExecutionOverride("thread-c")).toEqual({
      model: "latest-model",
    });
    releaseNext();
    await next;
    expect(order).toEqual(["thread-c:failed", "thread-c:next"]);
    expect(getPendingThreadExecutionOverride("thread-c")).toBeNull();
  });

  it("removes a failed field while a disjoint save is still pending", async () => {
    let rejectModelSave!: (error: Error) => void;
    const modelSave = new Promise<void>((_resolve, reject) => {
      rejectModelSave = reject;
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
      () => modelSave,
    );
    const pendingTier = enqueueThreadExecutionOverrideSave(
      "thread-d",
      { serviceTier: "fast" },
      async () => {
        markTierStarted();
        await tierGate;
      },
    );

    expect(getPendingThreadExecutionOverride("thread-d")).toEqual({
      model: "failed-model",
      reasoningLevel: "high",
      serviceTier: "fast",
    });

    const failedModelAssertion = expect(failedModel).rejects.toThrow(
      "model save failed",
    );
    rejectModelSave(new Error("model save failed"));
    await failedModelAssertion;
    await tierStarted;
    expect(getPendingThreadExecutionOverride("thread-d")).toEqual({
      serviceTier: "fast",
    });

    releaseTierSave();
    await pendingTier;
    expect(getPendingThreadExecutionOverride("thread-d")).toBeNull();
  });
});
