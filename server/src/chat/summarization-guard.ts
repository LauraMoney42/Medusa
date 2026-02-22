/**
 * Shared guard to prevent concurrent summarization of the same session.
 * Both handler.ts and autonomous-deliver.ts import this Set.
 * If a session ID is in the set, summarization is already in-flight → skip.
 */
export const summarizingSessionIds = new Set<string>();
