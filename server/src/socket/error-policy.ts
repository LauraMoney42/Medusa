/**
 * Pure helpers for the socket handler's error-handling policy.
 *
 * Extracted out of handler.ts so the dedupe/auth-error rules can be unit
 * tested without spinning up a Socket.IO server. Two problems this fixes:
 *
 * 1. Tier escalation (haiku -> sonnet -> opus) re-runs the same prompt and
 *    each failed attempt used to emit its own `message:error`, so the client
 *    rendered the same error text two or three times in a row.
 * 2. An auth error (the `claude` CLI is not logged in) cannot be fixed by
 *    trying a different model tier, so escalating on that error just wastes
 *    time and repeats the same failure.
 */

/**
 * True when `message` looks like a Claude CLI "not logged in" error.
 * A different model tier can't fix this, so the caller should stop
 * escalating immediately instead of retrying on sonnet/opus.
 */
export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not logged in") || lower.includes("/login");
}

/**
 * Tracks the last error message seen across a send's tier-escalation
 * attempts, and reports whether a new message is an immediate repeat of it.
 * Used to collapse identical consecutive error events (e.g. the same
 * "Not logged in" message emitted by every escalation tier) into one line.
 */
export class ConsecutiveErrorDeduper {
  private last: string | null = null;

  /**
   * Returns true if `message` should be emitted, i.e. it differs from the
   * immediately preceding message. Always records `message` as the new
   * "last" value, whether or not it was a duplicate.
   */
  shouldEmit(message: string): boolean {
    const isDuplicate = message === this.last;
    this.last = message;
    return !isDuplicate;
  }

  /** The most recently seen message, or null if none has been recorded yet. */
  getLast(): string | null {
    return this.last;
  }
}

/**
 * Builds the single summary line shown once every model tier has failed.
 *
 * The `claude /login` hint only makes sense for an auth error -- no model
 * tier and no MCP server can fix "not logged in", but the reverse also
 * holds: telling someone to log back in when the real problem is an MCP
 * connection failure sends them chasing the wrong fix. So the login
 * command is appended only when `isAuthError()` recognizes the error;
 * otherwise the message ends with the error text, plus one extra hint when
 * the error mentions MCP (the subagent shim failing to start, which fails
 * the engine's whole turn -- see server/src/mcp/config.ts
 * descriptorForSession) pointing at the Activity Log instead.
 */
export function buildAllTiersFailedMessage(
  lastError: string,
  configDir?: string
): string {
  if (isAuthError(lastError)) {
    const loginCmd = configDir
      ? `CLAUDE_CONFIG_DIR=${configDir} claude /login`
      : "claude /login";
    return `All models failed: ${lastError}. Run \`${loginCmd}\` in the config dir Medusa uses.`;
  }

  if (lastError.toLowerCase().includes("mcp")) {
    return `All models failed: ${lastError}. Subagent tools failed to start; see the Activity Log.`;
  }

  return `All models failed: ${lastError}.`;
}
