#!/usr/bin/env node
/**
 * The `medusa` MCP server.
 *
 * Every engine Medusa drives (`claude`, `kimi`, any ACP agent) is a separate
 * OS process, so an in-process MCP object mounted on Express would be
 * unreachable. This file is the bridge: the engine spawns it over stdio, it
 * speaks MCP on stdin/stdout, and it speaks plain HTTP back to the Medusa
 * server on 127.0.0.1 with the Bearer token it was handed at spawn.
 *
 * It is deliberately generic. Tools come from `tools.ts` as data and are
 * turned into HTTP calls mechanically, so the Browser/Simulator/files tools
 * of the Medusa tools layer can be added there without touching this file.
 *
 * Environment (see descriptor.ts):
 *   MEDUSA_URL                 http://127.0.0.1:<port>
 *   MEDUSA_TOKEN               AUTH_TOKEN
 *   MEDUSA_PARENT_SESSION_ID   the only chat this shim may ever see
 *   MEDUSA_MCP_TOOLSETS        optional comma-separated toolset filter
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_ENV, MEDUSA_MCP_SERVER_NAME } from "./descriptor.js";
import { selectTools, type McpToolSpec } from "./tools.js";

import { callMedusa, readShimEnv, type ShimEnv } from "./client.js";
export { callMedusa, readShimEnv, type ShimEnv };

export function createShimServer(shim: ShimEnv): Server {
  const tools = selectTools(shim.toolsets);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: MEDUSA_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = byName.get(request.params.name);
    if (!spec) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const missing = (spec.inputSchema.required ?? []).filter(
      (key) => args[key] === undefined || args[key] === null || args[key] === ""
    );
    if (missing.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${spec.name} requires: ${missing.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const { text, isError } = await callMedusa(shim, spec, args);
    return { content: [{ type: "text" as const, text }], isError };
  });

  return server;
}

export async function main(): Promise<void> {
  const shim = readShimEnv();
  const server = createShimServer(shim);
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly, so the unit tests can import the helpers.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stdout is the MCP channel; diagnostics must go to stderr.
    console.error("[medusa-mcp-shim]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
