import fs from "fs";
import path from "path";
import config from "../config.js";
import {
  buildMedusaMcpDescriptor,
  type BuildDescriptorOptions,
  type MedusaMcpDescriptor,
} from "./descriptor.js";

export {
  buildMedusaMcpDescriptor,
  resolveShimPath,
  MEDUSA_MCP_SERVER_NAME,
  MCP_ENV,
  type MedusaMcpDescriptor,
  type BuildDescriptorOptions,
} from "./descriptor.js";

/** The object-map spelling, shared by `claude --mcp-config` and `kimi --mcp-config`. */
export interface McpStdioEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The ACP `session/new.mcpServers` spelling: an array with env as name/value pairs. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function toStdioEntry(descriptor: MedusaMcpDescriptor): McpStdioEntry {
  return {
    type: "stdio",
    command: descriptor.command,
    args: [...descriptor.args],
    env: { ...descriptor.env },
  };
}

/**
 * The JSON blob passed to `claude --mcp-config <json>` and
 * `kimi --mcp-config <json>`. Both CLIs accept a JSON *string* as well as a
 * file path, which is why no temp file is involved.
 *
 * Deliberately NOT paired with `--strict-mcp-config`: the user's own
 * `.mcp.json` servers stay available to Medusa (spec A.5).
 */
export function buildMcpConfigJson(descriptor: MedusaMcpDescriptor): string {
  return JSON.stringify({
    mcpServers: { [descriptor.serverName]: toStdioEntry(descriptor) },
  });
}

/**
 * The same descriptor in the array form ACP's `session/new` expects. Derived
 * from `toStdioEntry` so the two spellings cannot drift.
 */
export function buildAcpMcpServers(
  descriptor: MedusaMcpDescriptor
): AcpMcpServer[] {
  const entry = toStdioEntry(descriptor);
  return [
    {
      name: descriptor.serverName,
      command: entry.command,
      args: entry.args,
      env: Object.entries(entry.env).map(([name, value]) => ({ name, value })),
    },
  ];
}

/**
 * True when a `node` executable can be found on PATH. Uses `fs.existsSync`
 * (rather than shelling out) so it stays fast, synchronous, and mockable
 * with a plain `fs` mock in tests -- the same style as the shim-path check
 * this backs.
 */
function isNodeOnPath(): boolean {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      return fs.existsSync(path.join(dir, "node"));
    } catch {
      return false;
    }
  });
}

/**
 * Verifies a descriptor's shim is actually reachable before it is handed to
 * an engine: the compiled `node <path>` shape needs both `node` on PATH and
 * the script file on disk; the desktop `MEDUSA_MCP_SHIM_BIN` shape (bare
 * binary, no args) just needs the binary file on disk. Returns a one-line
 * warning describing what is missing, or null when the descriptor is good.
 */
function shimUnavailableReason(descriptor: MedusaMcpDescriptor): string | null {
  if (descriptor.command === "node") {
    const scriptPath = descriptor.args[0];
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return `Medusa MCP shim script not found at ${scriptPath ?? "(no path)"}`;
    }
    if (!isNodeOnPath()) {
      return "Medusa MCP shim needs `node`, but no `node` executable was found on PATH";
    }
    return null;
  }

  if (!fs.existsSync(descriptor.command)) {
    return `Medusa MCP shim binary not found at ${descriptor.command}`;
  }
  return null;
}

/**
 * Convenience for the spawn path: build the descriptor from the running
 * server's own config. Returns null when no AUTH_TOKEN is set, because an
 * unauthenticated shim would let any local process drive subagents.
 *
 * Also returns null -- engines then spawn without --mcp-config, so chat
 * still works with subagents unavailable -- when the shim itself cannot
 * actually be launched (the bug this guards against: a `bun build
 * --compile` sidecar whose `import.meta.url`-relative path resolves inside
 * its own virtual filesystem, so `node <shim path>` fails and Kimi/Claude
 * fail their *entire* turn with "Failed to connect MCP servers"). `onWarning`
 * is called with one clear, human-readable line describing what's missing so
 * the caller (server/src/socket/handler.ts) can surface it in the Activity
 * Log; the same line is also logged with `console.warn` unconditionally.
 */
export function descriptorForSession(
  parentSessionId: string,
  overrides: Partial<BuildDescriptorOptions> = {},
  onWarning?: (message: string) => void
): MedusaMcpDescriptor | null {
  if (!config.authToken) return null;
  const descriptor = buildMedusaMcpDescriptor({
    parentSessionId,
    serverUrl: `http://127.0.0.1:${config.port}`,
    authToken: config.authToken,
    ...overrides,
  });

  const reason = shimUnavailableReason(descriptor);
  if (reason) {
    const message = `[mcp] ${reason}; spawning without subagent tools for this session.`;
    console.warn(message);
    onWarning?.(message);
    return null;
  }

  return descriptor;
}
