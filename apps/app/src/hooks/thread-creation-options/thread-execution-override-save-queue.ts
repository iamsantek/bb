import type { ResolvedThreadExecutionOptions } from "@bb/domain";
import type { UpdateThreadRequest } from "@bb/server-contract";

export type ThreadExecutionOverridePatch = Pick<
  UpdateThreadRequest,
  "model" | "reasoningLevel" | "serviceTier"
>;

type ThreadExecutionOverrideField = keyof ThreadExecutionOverridePatch;

interface PendingThreadExecutionOverride {
  patch: ThreadExecutionOverridePatch;
  revisions: Partial<Record<ThreadExecutionOverrideField, number>>;
  awaitingCanonical: Partial<Record<ThreadExecutionOverrideField, number>>;
  awaitingCanonicalAfter: Partial<Record<ThreadExecutionOverrideField, number>>;
  pendingSaves: number;
}

interface ThreadExecutionOverrideSaveOptions {
  retainUntilCanonical?: boolean;
  getCanonicalReadVersion?: () => number;
  onSaved?: () => void;
  onFailed?: () => void;
}

const pendingSavesByThreadId = new Map<string, Promise<void>>();
const pendingOverridesByThreadId = new Map<
  string,
  PendingThreadExecutionOverride
>();
const listenersByThreadId = new Map<string, Set<() => void>>();
const canonicalReadVersionsByThreadId = new Map<string, number>();
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

export function getThreadExecutionOptionsCanonicalReadVersion(
  threadId: string,
): number {
  return canonicalReadVersionsByThreadId.get(threadId) ?? 0;
}

export function recordThreadExecutionOptionsCanonicalRead(
  threadId: string,
): number {
  if (!pendingOverridesByThreadId.has(threadId)) return 0;
  const nextVersion =
    (canonicalReadVersionsByThreadId.get(threadId) ?? 0) + 1;
  canonicalReadVersionsByThreadId.set(threadId, nextVersion);
  return nextVersion;
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
  options: ThreadExecutionOverrideSaveOptions = {},
): Promise<TResult> {
  const current = pendingOverridesByThreadId.get(threadId);
  const revision = ++nextSaveRevision;
  const revisions = { ...current?.revisions };
  const awaitingCanonical = { ...current?.awaitingCanonical };
  const awaitingCanonicalAfter = { ...current?.awaitingCanonicalAfter };
  for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
    revisions[field] = revision;
    delete awaitingCanonical[field];
    delete awaitingCanonicalAfter[field];
  }
  pendingOverridesByThreadId.set(threadId, {
    patch: { ...current?.patch, ...patch },
    revisions,
    awaitingCanonical,
    awaitingCanonicalAfter,
    pendingSaves: (current?.pendingSaves ?? 0) + 1,
  });
  notifyPendingOverrideListeners(threadId);

  const previous = pendingSavesByThreadId.get(threadId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(save);
  const trackedOperation = operation.then(
    (result) => {
      settlePendingOverride(
        threadId,
        patch,
        revision,
        false,
        options.retainUntilCanonical ?? false,
        options.getCanonicalReadVersion?.() ?? 0,
      );
      options.onSaved?.();
      return result;
    },
    (error: unknown) => {
      settlePendingOverride(threadId, patch, revision, true, false, 0);
      options.onFailed?.();
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
  retainUntilCanonical: boolean,
  canonicalDataUpdateCount: number,
): void {
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return;
  let nextPatch = current.patch;
  let nextRevisions = current.revisions;
  let nextAwaitingCanonical = current.awaitingCanonical;
  let nextAwaitingCanonicalAfter = current.awaitingCanonicalAfter;
  if (failed) {
    nextPatch = { ...current.patch };
    nextRevisions = { ...current.revisions };
    nextAwaitingCanonical = { ...current.awaitingCanonical };
    nextAwaitingCanonicalAfter = { ...current.awaitingCanonicalAfter };
    for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
      if (current.revisions[field] !== revision) continue;
      delete nextPatch[field];
      delete nextRevisions[field];
      delete nextAwaitingCanonical[field];
      delete nextAwaitingCanonicalAfter[field];
    }
  } else if (retainUntilCanonical) {
    nextAwaitingCanonical = { ...current.awaitingCanonical };
    nextAwaitingCanonicalAfter = { ...current.awaitingCanonicalAfter };
    for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
      if (current.revisions[field] === revision) {
        nextAwaitingCanonical[field] = revision;
        nextAwaitingCanonicalAfter[field] = canonicalDataUpdateCount;
      }
    }
  } else if (current.pendingSaves === 1) {
    pendingOverridesByThreadId.delete(threadId);
    canonicalReadVersionsByThreadId.delete(threadId);
    notifyPendingOverrideListeners(threadId);
    return;
  }
  const pendingSaves = current.pendingSaves - 1;
  if (pendingSaves === 0 && Object.keys(nextPatch).length === 0) {
    pendingOverridesByThreadId.delete(threadId);
    canonicalReadVersionsByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      patch: nextPatch,
      revisions: nextRevisions,
      awaitingCanonical: nextAwaitingCanonical,
      awaitingCanonicalAfter: nextAwaitingCanonicalAfter,
      pendingSaves,
    });
  }
  notifyPendingOverrideListeners(threadId);
}

export function acknowledgeThreadExecutionOverride(
  threadId: string,
  canonicalOptions: ResolvedThreadExecutionOptions | null,
  canonicalReadVersion: number,
): void {
  if (canonicalOptions === null) return;
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return;
  const nextPatch = { ...current.patch };
  const nextRevisions = { ...current.revisions };
  const nextAwaitingCanonical = { ...current.awaitingCanonical };
  const nextAwaitingCanonicalAfter = { ...current.awaitingCanonicalAfter };
  let changed = false;
  for (const field of Object.keys(nextAwaitingCanonical) as ThreadExecutionOverrideField[]) {
    const revision = nextAwaitingCanonical[field];
    if (revision === undefined) continue;
    if (
      canonicalReadVersion <=
      (nextAwaitingCanonicalAfter[field] ?? Number.POSITIVE_INFINITY)
    ) {
      continue;
    }
    if (current.revisions[field] !== revision) {
      delete nextAwaitingCanonical[field];
      delete nextAwaitingCanonicalAfter[field];
      changed = true;
      continue;
    }
    const expected = nextPatch[field];
    const actual = canonicalOptions[field];
    if (expected !== null && expected !== actual) continue;
    delete nextPatch[field];
    delete nextRevisions[field];
    delete nextAwaitingCanonical[field];
    delete nextAwaitingCanonicalAfter[field];
    changed = true;
  }
  if (!changed) return;
  if (current.pendingSaves === 0 && Object.keys(nextPatch).length === 0) {
    pendingOverridesByThreadId.delete(threadId);
    canonicalReadVersionsByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      patch: nextPatch,
      revisions: nextRevisions,
      awaitingCanonical: nextAwaitingCanonical,
      awaitingCanonicalAfter: nextAwaitingCanonicalAfter,
      pendingSaves: current.pendingSaves,
    });
  }
  notifyPendingOverrideListeners(threadId);
}
