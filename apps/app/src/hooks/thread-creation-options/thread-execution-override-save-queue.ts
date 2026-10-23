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
  successfulPatch: ThreadExecutionOverridePatch;
  successfulRevisions: Partial<Record<ThreadExecutionOverrideField, number>>;
  successfulAfter: Partial<Record<ThreadExecutionOverrideField, number>>;
  retainSuccessfulUntilCanonical: boolean;
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
const pendingOverrideSnapshots = new WeakMap<
  PendingThreadExecutionOverride,
  ThreadExecutionOverridePatch | null
>();
let nextSaveRevision = 0;

function notifyPendingOverrideListeners(threadId: string): void {
  for (const listener of listenersByThreadId.get(threadId) ?? []) {
    listener();
  }
}

export function getPendingThreadExecutionOverride(
  threadId: string,
): ThreadExecutionOverridePatch | null {
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return null;
  const snapshot = pendingOverrideSnapshots.get(current);
  if (snapshot !== undefined) return snapshot;
  const patch = { ...current.successfulPatch, ...current.patch };
  const nextSnapshot = Object.keys(patch).length === 0 ? null : patch;
  pendingOverrideSnapshots.set(current, nextSnapshot);
  return nextSnapshot;
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
  const nextVersion = (canonicalReadVersionsByThreadId.get(threadId) ?? 0) + 1;
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
  const retainSuccessfulUntilCanonical =
    (current?.retainSuccessfulUntilCanonical ?? false) ||
    (options.retainUntilCanonical ?? false);
  for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
    revisions[field] = revision;
  }
  pendingOverridesByThreadId.set(threadId, {
    patch: { ...current?.patch, ...patch },
    revisions,
    successfulPatch: { ...current?.successfulPatch },
    successfulRevisions: { ...current?.successfulRevisions },
    successfulAfter: { ...current?.successfulAfter },
    retainSuccessfulUntilCanonical,
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
  const settled = trackedOperation.then(
    () => undefined,
    () => undefined,
  );
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
  canonicalReadVersion: number,
): void {
  const current = pendingOverridesByThreadId.get(threadId);
  if (current === undefined) return;
  const nextPatch = { ...current.patch };
  const nextRevisions = { ...current.revisions };
  const nextSuccessfulPatch = { ...current.successfulPatch };
  const nextSuccessfulRevisions = { ...current.successfulRevisions };
  const nextSuccessfulAfter = { ...current.successfulAfter };
  if (failed) {
    for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
      if (current.revisions[field] !== revision) continue;
      delete nextPatch[field];
      delete nextRevisions[field];
    }
  } else {
    for (const field of Object.keys(patch) as ThreadExecutionOverrideField[]) {
      nextSuccessfulPatch[field] = patch[field];
      nextSuccessfulRevisions[field] = revision;
      nextSuccessfulAfter[field] = canonicalReadVersion;
      if (current.revisions[field] === revision) {
        delete nextPatch[field];
        delete nextRevisions[field];
      }
    }
  }
  const pendingSaves = current.pendingSaves - 1;
  if (pendingSaves === 0 && !current.retainSuccessfulUntilCanonical) {
    for (const field of Object.keys(
      nextSuccessfulPatch,
    ) as ThreadExecutionOverrideField[]) {
      delete nextSuccessfulPatch[field];
      delete nextSuccessfulRevisions[field];
      delete nextSuccessfulAfter[field];
    }
  }
  if (
    pendingSaves === 0 &&
    Object.keys(nextPatch).length === 0 &&
    Object.keys(nextSuccessfulPatch).length === 0
  ) {
    pendingOverridesByThreadId.delete(threadId);
    canonicalReadVersionsByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      patch: nextPatch,
      revisions: nextRevisions,
      successfulPatch: nextSuccessfulPatch,
      successfulRevisions: nextSuccessfulRevisions,
      successfulAfter: nextSuccessfulAfter,
      retainSuccessfulUntilCanonical:
        current.retainSuccessfulUntilCanonical || retainUntilCanonical,
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
  const nextSuccessfulPatch = { ...current.successfulPatch };
  const nextSuccessfulRevisions = { ...current.successfulRevisions };
  const nextSuccessfulAfter = { ...current.successfulAfter };
  let changed = false;
  for (const field of Object.keys(
    nextSuccessfulPatch,
  ) as ThreadExecutionOverrideField[]) {
    const revision = nextSuccessfulRevisions[field];
    if (revision === undefined) continue;
    if (
      canonicalReadVersion <=
      (nextSuccessfulAfter[field] ?? Number.POSITIVE_INFINITY)
    ) {
      continue;
    }
    const expected = nextSuccessfulPatch[field];
    const actual = canonicalOptions[field];
    if (expected !== null && expected !== actual) continue;
    delete nextSuccessfulPatch[field];
    delete nextSuccessfulRevisions[field];
    delete nextSuccessfulAfter[field];
    changed = true;
  }
  if (!changed) return;
  if (
    current.pendingSaves === 0 &&
    Object.keys(nextPatch).length === 0 &&
    Object.keys(nextSuccessfulPatch).length === 0
  ) {
    pendingOverridesByThreadId.delete(threadId);
    canonicalReadVersionsByThreadId.delete(threadId);
  } else {
    pendingOverridesByThreadId.set(threadId, {
      patch: nextPatch,
      revisions: nextRevisions,
      successfulPatch: nextSuccessfulPatch,
      successfulRevisions: nextSuccessfulRevisions,
      successfulAfter: nextSuccessfulAfter,
      retainSuccessfulUntilCanonical: current.retainSuccessfulUntilCanonical,
      pendingSaves: current.pendingSaves,
    });
  }
  notifyPendingOverrideListeners(threadId);
}
