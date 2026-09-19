import { describe, it, expect } from "vitest";
import path from "path";
import {
  buildMcpConfigJson,
  buildAcpMcpServers,
  buildMedusaMcpDescriptor,
  MEDUSA_MCP_SERVER_NAME,
  MCP_ENV,
  resolveShimPath,
  type McpStdioEntry,
} from "../config.js";
import {
  ALL_MCP_TOOLS,
  selectTools,
  SUBAGENT_TOOLSET,
  SCREENSHOT_TOOLSET,
} from "../tools.js";

function descriptor(overrides = {}) {
  return buildMedusaMcpDescriptor({
    parentSessionId: "sess-1",
    serverUrl: "http://127.0.0.1:3456",
    authToken: "tok-abc",
    shimPath: "/srv/medusa/server/dist/mcp/medusa-mcp-shim.js",
    ...overrides,
  });
}

describe("buildMedusaMcpDescriptor", () => {
  it("names the server medusa and carries url, token and parent session", () => {
    const d = descriptor();
    expect(d.serverName).toBe(MEDUSA_MCP_SERVER_NAME);
    expect(d.serverName).toBe("medusa");
    expect(d.command).toBe("node");
    expect(d.args).toEqual(["/srv/medusa/server/dist/mcp/medusa-mcp-shim.js"]);
    expect(d.env).toEqual({
      [MCP_ENV.url]: "http://127.0.0.1:3456",
      [MCP_ENV.token]: "tok-abc",
      [MCP_ENV.parentSessionId]: "sess-1",
    });
  });

  it("adds a toolset filter only when one is requested", () => {
    expect(descriptor().env[MCP_ENV.toolsets]).toBeUndefined();
    expect(descriptor({ toolsets: ["subagents", "browser"] }).env[MCP_ENV.toolsets]).toBe(
      "subagents,browser"
    );
  });

  it("falls back to a resolved shim path", () => {
    const d = buildMedusaMcpDescriptor({
      parentSessionId: "s",
      serverUrl: "http://127.0.0.1:3456",
      authToken: "t",
    });
    expect(d.args[0]).toBe(resolveShimPath());
    expect(path.basename(d.args[0]!)).toBe("medusa-mcp-shim.js");
    expect(path.isAbsolute(d.args[0]!)).toBe(true);
  });
});

describe("buildMcpConfigJson", () => {
  it("produces the stdio shape under mcpServers.medusa", () => {
    const json = buildMcpConfigJson(descriptor());
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, McpStdioEntry>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(["medusa"]);
    expect(parsed.mcpServers.medusa).toEqual({
      type: "stdio",
      command: "node",
      args: ["/srv/medusa/server/dist/mcp/medusa-mcp-shim.js"],
      env: {
        MEDUSA_URL: "http://127.0.0.1:3456",
        MEDUSA_TOKEN: "tok-abc",
        MEDUSA_PARENT_SESSION_ID: "sess-1",
      },
    });
  });

  it("is a single-line string an argv can carry", () => {
    const json = buildMcpConfigJson(descriptor());
    expect(json).not.toContain("\n");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("does not share mutable state with the descriptor", () => {
    const d = descriptor();
    buildMcpConfigJson(d);
    d.args.push("mutated");
    const parsed = JSON.parse(buildMcpConfigJson(descriptor())) as {
      mcpServers: Record<string, McpStdioEntry>;
    };
    expect(parsed.mcpServers.medusa!.args).toHaveLength(1);
  });
});

describe("buildAcpMcpServers", () => {
  it("produces the array form with env as name/value pairs", () => {
    expect(buildAcpMcpServers(descriptor())).toEqual([
      {
        name: "medusa",
        command: "node",
        args: ["/srv/medusa/server/dist/mcp/medusa-mcp-shim.js"],
        env: [
          { name: "MEDUSA_URL", value: "http://127.0.0.1:3456" },
          { name: "MEDUSA_TOKEN", value: "tok-abc" },
          { name: "MEDUSA_PARENT_SESSION_ID", value: "sess-1" },
        ],
      },
    ]);
  });

  it("derives command, args and env from the same descriptor as the JSON form", () => {
    const d = descriptor();
    const cli = (
      JSON.parse(buildMcpConfigJson(d)) as { mcpServers: Record<string, McpStdioEntry> }
    ).mcpServers.medusa!;
    const acp = buildAcpMcpServers(d)[0]!;

    expect(acp.name).toBe("medusa");
    expect(acp.command).toBe(cli.command);
    expect(acp.args).toEqual(cli.args);
    expect(Object.fromEntries(acp.env.map((e) => [e.name, e.value]))).toEqual(cli.env);
  });
});

describe("the tool surface", () => {
  it("exposes the five subagent tools of spec A.4 plus take_screenshot", () => {
    expect(ALL_MCP_TOOLS.map((t) => t.name)).toEqual([
      "spawn_agent",
      "agent_status",
      "agent_result",
      "list_agents",
      "cancel_agent",
      "take_screenshot",
    ]);
  });

  it("requires task on spawn_agent and nothing on list_agents", () => {
    const spawn = ALL_MCP_TOOLS.find((t) => t.name === "spawn_agent")!;
    expect(spawn.inputSchema.required).toEqual(["task"]);
    expect(Object.keys(spawn.inputSchema.properties).sort()).toEqual([
      "cwd",
      "engine",
      "model",
      "name",
      "task",
      "wait",
    ]);
    const list = ALL_MCP_TOOLS.find((t) => t.name === "list_agents")!;
    expect(list.inputSchema.required).toBeUndefined();
  });

  it("maps each tool to one Medusa HTTP call", () => {
    const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
    expect(byName.get("spawn_agent")!.request({ task: "go" })).toEqual({
      method: "POST",
      path: "/api/subagents",
      body: { task: "go" },
    });
    expect(byName.get("agent_status")!.request({ agent_id: "sa_1" })).toEqual({
      method: "GET",
      path: "/api/subagents/sa_1",
    });
    expect(byName.get("agent_result")!.request({ agent_id: "sa_1" })).toEqual({
      method: "GET",
      path: "/api/subagents/sa_1/result",
    });
    expect(byName.get("list_agents")!.request({})).toEqual({
      method: "GET",
      path: "/api/subagents",
    });
    expect(byName.get("cancel_agent")!.request({ agent_id: "sa_1" })).toEqual({
      method: "POST",
      path: "/api/subagents/sa_1/cancel",
    });
  });

  it("escapes ids that arrive from the model", () => {
    const status = ALL_MCP_TOOLS.find((t) => t.name === "agent_status")!;
    expect(status.request({ agent_id: "../../etc/passwd" }).path).toBe(
      "/api/subagents/..%2F..%2Fetc%2Fpasswd"
    );
  });

  it("selects by toolset so more tool groups can share the shim", () => {
    expect(selectTools(null)).toEqual(ALL_MCP_TOOLS);
    expect(selectTools([])).toEqual(ALL_MCP_TOOLS);
    expect(selectTools([SUBAGENT_TOOLSET, SCREENSHOT_TOOLSET])).toEqual(ALL_MCP_TOOLS);
    expect(selectTools(["browser"])).toEqual([]);
  });

  it("can restrict to only the subagent tools, e.g. for Live mode", () => {
    expect(selectTools([SUBAGENT_TOOLSET]).map((t) => t.name)).toEqual([
      "spawn_agent",
      "agent_status",
      "agent_result",
      "list_agents",
      "cancel_agent",
    ]);
  });

  it("take_screenshot defaults to fullscreen, requires nothing, and posts to /api/screenshot", () => {
    const spec = ALL_MCP_TOOLS.find((t) => t.name === "take_screenshot")!;
    expect(spec.toolset).toBe(SCREENSHOT_TOOLSET);
    expect(spec.inputSchema.required).toBeUndefined();
    expect(
      (spec.inputSchema.properties.target as { enum: string[] }).enum
    ).toEqual(["fullscreen", "window", "region"]);
    expect(spec.request({})).toEqual({
      method: "POST",
      path: "/api/screenshot",
      body: {},
    });
    expect(spec.request({ target: "window" })).toEqual({
      method: "POST",
      path: "/api/screenshot",
      body: { target: "window" },
    });
  });
});
