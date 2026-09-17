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
 * Convenience for the spawn path: build the descriptor from the running
 * server's own config. Returns null when no AUTH_TOKEN is set, because an
 * unauthenticated shim would let any local process drive subagents.
 */
export function descriptorForSession(
  parentSessionId: string,
  overrides: Partial<BuildDescriptorOptions> = {}
): MedusaMcpDescriptor | null {
  if (!config.authToken) return null;
  return buildMedusaMcpDescriptor({
    parentSessionId,
    serverUrl: `http://127.0.0.1:${config.port}`,
    authToken: config.authToken,
    ...overrides,
  });
}
