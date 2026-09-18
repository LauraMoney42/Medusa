import { MCP_ENV } from "./descriptor.js";
import type { McpToolSpec } from "./tools.js";

// Kept free of the MCP SDK on purpose: the server bundle (bun single file)
// imports this for the realtime tool bridge, and the SDK's zod schemas do not
// survive bun's module hoisting. Only the shim binary imports the SDK.

/** Requests that are not long-running get a bounded timeout. */
const SHORT_REQUEST_TIMEOUT_MS = 30_000;

export interface ShimEnv {
  url: string;
  token: string;
  parentSessionId: string;
  toolsets: string[] | null;
}

export function readShimEnv(env: NodeJS.ProcessEnv = process.env): ShimEnv {
  const url = env[MCP_ENV.url];
  const token = env[MCP_ENV.token];
  const parentSessionId = env[MCP_ENV.parentSessionId];
  if (!url) throw new Error(`${MCP_ENV.url} is required`);
  if (!parentSessionId) throw new Error(`${MCP_ENV.parentSessionId} is required`);
  const raw = env[MCP_ENV.toolsets];
  return {
    url: url.replace(/\/+$/, ""),
    token: token ?? "",
    parentSessionId,
    toolsets: raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null,
  };
}

/** One tool call -> one HTTP round trip against the Medusa server. */
export async function callMedusa(
  shim: ShimEnv,
  spec: McpToolSpec,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string; isError: boolean }> {
  const req = spec.request(args);

  const headers: Record<string, string> = {
    // The parent session travels in a header, never as a tool argument, so a
    // model can neither read nor forge another chat's id.
    "x-medusa-parent-session-id": shim.parentSessionId,
    accept: "application/json",
  };
  if (shim.token) headers.authorization = `Bearer ${shim.token}`;
  if (req.body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timer = spec.longRunning
    ? null
    : setTimeout(() => controller.abort(), SHORT_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${shim.url}${req.path}`, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // Non-JSON body; report it verbatim.
      }
      return { text: `${spec.name} failed (${res.status}): ${message}`, isError: true };
    }
    return { text: text || "{}", isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `${spec.name} failed: ${message}`, isError: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
