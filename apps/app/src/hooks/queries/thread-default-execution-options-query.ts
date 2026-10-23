import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedThreadExecutionOptions } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import {
  readCachedThreadExecutionOptions,
  threadExecutionOptionsCacheKey,
  writeCachedThreadExecutionOptions,
} from "@/lib/thread-execution-options-cache";
import { useThreadDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { requireThreadId } from "./query-helpers";
import { threadDefaultExecutionOptionsQueryKey } from "./query-keys";
import { REALTIME_OWNED_NO_FOCUS_QUERY_POLICY } from "./query-policies";
import {
  acknowledgeThreadExecutionOverride,
  getThreadExecutionOptionsCanonicalReadVersion,
  recordThreadExecutionOptionsCanonicalRead,
} from "../thread-creation-options/thread-execution-override-save-queue";

export {
  allThreadDefaultExecutionOptionsQueryKeyPrefix,
  threadDefaultExecutionOptionsQueryKey,
} from "./query-keys";

interface ThreadDefaultExecutionOptionsQueryOptions {
  enabled?: boolean;
  refetchOnMount?: boolean | "always";
  staleTime?: number;
}

async function fetchThreadDefaultExecutionOptions(
  threadId: string,
  signal?: AbortSignal,
): Promise<ResolvedThreadExecutionOptions | null> {
  const options = await sdk.threads.defaultExecutionOptions({
    threadId,
    signal,
  });
  if (options !== null && !signal?.aborted) {
    recordThreadExecutionOptionsCanonicalRead(threadId);
    writeCachedThreadExecutionOptions(
      threadExecutionOptionsCacheKey(threadId),
      options,
    );
  }
  return options;
}

export function useThreadDefaultExecutionOptions(
  id: string,
  options?: ThreadDefaultExecutionOptionsQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(id);
  useThreadDetailRealtimeSubscription(id, { enabled });

  const queryKey = threadDefaultExecutionOptionsQueryKey(id);
  const query = useQuery<ResolvedThreadExecutionOptions | null>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchThreadDefaultExecutionOptions(
        requireThreadId(id, "useThreadDefaultExecutionOptions"),
        signal,
      ),
    enabled,
    refetchOnMount: options?.refetchOnMount ?? true,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
    staleTime: options?.staleTime,
    placeholderData: () =>
      id
        ? (readCachedThreadExecutionOptions(
            threadExecutionOptionsCacheKey(id),
          ) ?? undefined)
        : undefined,
  });
  const canonicalReadVersion =
    getThreadExecutionOptionsCanonicalReadVersion(id);

  useEffect(() => {
    if (
      !enabled ||
      query.data === undefined ||
      query.data === null ||
      query.isPlaceholderData ||
      query.isFetching ||
      !query.isSuccess
    ) {
      return;
    }
    acknowledgeThreadExecutionOverride(id, query.data, canonicalReadVersion);
  }, [
    canonicalReadVersion,
    enabled,
    id,
    query.data,
    query.isFetching,
    query.isPlaceholderData,
    query.isSuccess,
  ]);

  return query;
}
