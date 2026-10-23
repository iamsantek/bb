import type { UpdateThreadRequest } from "@bb/server-contract";

export type ThreadExecutionOverridePatch = Pick<
  UpdateThreadRequest,
  "model" | "reasoningLevel" | "serviceTier"
>;

interface PendingThreadExecutionOverride {
  patch: ThreadExecutionOverridePatch;
  pendingSaves: number;
}

const pendingSavesByThreadId = new Map<string, Promise<void>>();
const pendingOverridesByThreadId = new Map<
  string,
  PendingThreadExecutionOverride
>();
const listenersByThreadId = new Map<string, Set<() => void>>();

function notifyPendingOverrideListeners(threadId: string): void {
  for (const listener of listenersByThreadId.get(threadId) ?? []) {
    listener();
  }
}

export function getPendingThreadExecutionOverride(
  threadId: string,
): ThreadExecutionOverridePatch | null {
  return pendingOverridesByThreadId.get(threadId)?.patch ?? null;
}

export function subscribeToPendingThreadExecutionOverride(
  threadId: string,
  listener: () => void,
): () => void {
  const listeners = listenersByThreadId.get(threadId) ?? new Set();
  listeners.add(listener);
  listenersByThreadId.set(threadId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByThreadId.delete(threadId);
  };
}

export function enqueueThreadExecutionOverrideSave<TResult>(
  threadId: string,
  patch: ThreadExecutionOverridePatch,
  save: () => Promise<TResult>,
): Promise<TResult> {
  const current = pendingOverridesByThreadId.get(threadId);
  pendingOverridesByThreadId.set(threadId, {
    patch: { ...current?.patch, ...patch },
    pendingSaves: (current?.pendingSaves ?? 0) + 1,
  });
  notifyPendingOverrideListeners(threadId);

  const previous = pendingSavesByThreadId.get(threadId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(save);
  const trackedOperation = operation.then(
    (result) => {
      settlePendingOverride(threadId);
      return result;
    },
    (error: unknown) => {
      settlePendingOverride(threadId);
      throw error;
    },
  );
  const settled = trackedOperation.then(() => undefined, () => undefined);
  pendingSavesByThreadId.set(threadId, settled);
  void settled.then(() => {
    if (pendingSavesByThreadId.get(threadId) === settled) {
      pendingSavesByThreadId.delete(threadId);
    }
  });
  return trackedOperation;
}

function settlePendingOverride(threadId: string): void {
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return;
  if (current.pendingSaves === 1) {
    pendingOverridesByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      ...current,
      pendingSaves: current.pendingSaves - 1,
    });
  }
  notifyPendingOverrideListeners(threadId);
}
