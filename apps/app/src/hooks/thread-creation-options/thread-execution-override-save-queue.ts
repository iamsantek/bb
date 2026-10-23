import type { UpdateThreadRequest } from "@bb/server-contract";

export type ThreadExecutionOverridePatch = Pick<
  UpdateThreadRequest,
  "model" | "reasoningLevel" | "serviceTier"
>;

type ThreadExecutionOverrideField = keyof ThreadExecutionOverridePatch;

interface PendingThreadExecutionOverride {
  patch: ThreadExecutionOverridePatch;
  revisions: Partial<Record<ThreadExecutionOverrideField, number>>;
  pendingSaves: number;
}

const pendingSavesByThreadId = new Map<string, Promise<void>>();
const pendingOverridesByThreadId = new Map<
  string,
  PendingThreadExecutionOverride
>();
const listenersByThreadId = new Map<string, Set<() => void>>();
let nextSaveRevision = 0;

function notifyPendingOverrideListeners(threadId: string): void {
  for (const listener of listenersByThreadId.get(threadId) ?? []) {
    listener();
  }
}

export function getPendingThreadExecutionOverride(
  threadId: string,
): ThreadExecutionOverridePatch | null {
  const patch = pendingOverridesByThreadId.get(threadId)?.patch;
  return patch === undefined || Object.keys(patch).length === 0 ? null : patch;
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
  const revision = ++nextSaveRevision;
  const revisions = { ...current?.revisions };
  for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
    revisions[field] = revision;
  }
  pendingOverridesByThreadId.set(threadId, {
    patch: { ...current?.patch, ...patch },
    revisions,
    pendingSaves: (current?.pendingSaves ?? 0) + 1,
  });
  notifyPendingOverrideListeners(threadId);

  const previous = pendingSavesByThreadId.get(threadId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(save);
  const trackedOperation = operation.then(
    (result) => {
      settlePendingOverride(threadId, patch, revision, false);
      return result;
    },
    (error: unknown) => {
      settlePendingOverride(threadId, patch, revision, true);
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

function settlePendingOverride(
  threadId: string,
  patch: ThreadExecutionOverridePatch,
  revision: number,
  failed: boolean,
): void {
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return;
  let nextPatch = current.patch;
  let nextRevisions = current.revisions;
  if (failed) {
    nextPatch = { ...current.patch };
    nextRevisions = { ...current.revisions };
    for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
      if (current.revisions[field] !== revision) continue;
      delete nextPatch[field];
      delete nextRevisions[field];
    }
  }
  if (current.pendingSaves === 1) {
    pendingOverridesByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      patch: nextPatch,
      revisions: nextRevisions,
      pendingSaves: current.pendingSaves - 1,
    });
  }
  notifyPendingOverrideListeners(threadId);
}
