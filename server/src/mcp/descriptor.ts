import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The single source of truth for "how does an engine reach the Medusa MCP
 * server". Both `buildMcpConfigJson()` (the CLI object-map spelling) and
 * `buildAcpMcpServers()` (the ACP array spelling) are derived from one of
 * these, so the two shapes cannot drift apart.
 *
 * Why a descriptor rather than each engine building its own blob: the
 * `medusa` MCP server is not only about subagents. Per the 2026-09-17 UI and
 * layer addendum, the same stdio shim is the delivery mechanism for the whole
 * Medusa tools layer (Browser/CDP, Simulator/idb, local files, shell), so the
 * descriptor carries a `toolsets` list rather than hard-coding one tool group.
 */
export interface MedusaMcpDescriptor {
  /** The MCP server name engines see. Always `medusa`. */
  serverName: string;
  /** Executable that runs the shim. */
  command: string;
  /** argv for the shim, `[<abs path to medusa-mcp-shim.js>]`. */
  args: string[];
  /** Environment handed to the shim child process. */
  env: Record<string, string>;
}

/** The MCP server name. Engines expose its tools as `mcp__medusa__<tool>`. */
export const MEDUSA_MCP_SERVER_NAME = "medusa";

/** Env var names the shim reads. Exported so the shim and tests agree. */
export const MCP_ENV = {
  url: "MEDUSA_URL",
  token: "MEDUSA_TOKEN",
  parentSessionId: "MEDUSA_PARENT_SESSION_ID",
  /** Comma-separated toolset ids; unset means "every registered toolset". */
  toolsets: "MEDUSA_MCP_TOOLSETS",
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the compiled shim.
 *
 * Order: an explicit override, then the sibling `.js` next to this module
 * (the normal `server/dist/mcp/` case), then `<server root>/dist/mcp/`, which
 * is what `tsx`/vitest hit because this module is then running from
 * `server/src/mcp/`. The last candidate is returned even when it does not
 * exist so the failure surfaces at spawn time with a readable path rather
 * than as a silently missing MCP server.
 */
export function resolveShimPath(): string {
  const override = process.env.MEDUSA_MCP_SHIM_PATH;
  if (override) return path.resolve(override);

  const sibling = path.join(here, "medusa-mcp-shim.js");
  if (fs.existsSync(sibling)) return sibling;

  // src/mcp -> src -> server
  const serverRoot = path.resolve(here, "..", "..");
  return path.join(serverRoot, "dist", "mcp", "medusa-mcp-shim.js");
}

export interface BuildDescriptorOptions {
  /** The chat whose subagents this shim may see. */
  parentSessionId: string;
  /** `http://127.0.0.1:<port>` */
  serverUrl: string;
  /** Medusa's AUTH_TOKEN, sent as a Bearer header by the shim. */
  authToken: string;
  /** Override the shim path (tests, Tauri sidecar bundles). */
  shimPath?: string;
  /** Override the executable. Defaults to `node` on PATH. */
  command?: string;
  /** Restrict which toolsets the shim exposes. Omit for all of them. */
  toolsets?: string[];
}

export function buildMedusaMcpDescriptor(
  opts: BuildDescriptorOptions
): MedusaMcpDescriptor {
  const env: Record<string, string> = {
    [MCP_ENV.url]: opts.serverUrl,
    [MCP_ENV.token]: opts.authToken,
    [MCP_ENV.parentSessionId]: opts.parentSessionId,
  };
  if (opts.toolsets && opts.toolsets.length > 0) {
    env[MCP_ENV.toolsets] = opts.toolsets.join(",");
  }

  return {
    serverName: MEDUSA_MCP_SERVER_NAME,
    command: opts.command ?? "node",
    args: [opts.shimPath ? path.resolve(opts.shimPath) : resolveShimPath()],
    env,
  };
}
