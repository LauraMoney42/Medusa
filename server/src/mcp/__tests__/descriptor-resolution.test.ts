import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { buildMedusaMcpDescriptor, resolveShimPath } from "../descriptor.js";

/**
 * Resolution order for how an engine reaches the `medusa` MCP shim (see
 * descriptor.ts's own comment block): MEDUSA_MCP_SHIM_BIN (desktop sidecar
 * binary, no `node`, no script arg) wins over MEDUSA_MCP_SHIM_PATH (`node
 * <path>`), which wins over the default `resolveShimPath()` lookup.
 */
describe("descriptor resolution order", () => {
  const savedBin = process.env.MEDUSA_MCP_SHIM_BIN;
  const savedPath = process.env.MEDUSA_MCP_SHIM_PATH;

  afterEach(() => {
    if (savedBin === undefined) delete process.env.MEDUSA_MCP_SHIM_BIN;
    else process.env.MEDUSA_MCP_SHIM_BIN = savedBin;
    if (savedPath === undefined) delete process.env.MEDUSA_MCP_SHIM_PATH;
    else process.env.MEDUSA_MCP_SHIM_PATH = savedPath;
  });

  function baseOpts() {
    return {
      parentSessionId: "sess-1",
      serverUrl: "http://127.0.0.1:3456",
      authToken: "tok-abc",
    };
  }

  it("runs the bundled binary directly when MEDUSA_MCP_SHIM_BIN is set", () => {
    delete process.env.MEDUSA_MCP_SHIM_PATH;
    process.env.MEDUSA_MCP_SHIM_BIN = "/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim";

    const d = buildMedusaMcpDescriptor(baseOpts());

    expect(d.command).toBe("/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim");
    expect(d.args).toEqual([]);
  });

  it("prefers MEDUSA_MCP_SHIM_BIN over MEDUSA_MCP_SHIM_PATH when both are set", () => {
    process.env.MEDUSA_MCP_SHIM_BIN = "/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim";
    process.env.MEDUSA_MCP_SHIM_PATH = "/srv/medusa/server/dist/mcp/medusa-mcp-shim.js";

    const d = buildMedusaMcpDescriptor(baseOpts());

    expect(d.command).toBe("/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim");
    expect(d.args).toEqual([]);
  });

  it("falls back to `node <MEDUSA_MCP_SHIM_PATH>` when only the path override is set", () => {
    delete process.env.MEDUSA_MCP_SHIM_BIN;
    process.env.MEDUSA_MCP_SHIM_PATH = "/srv/medusa/server/dist/mcp/medusa-mcp-shim.js";

    const d = buildMedusaMcpDescriptor(baseOpts());

    expect(d.command).toBe("node");
    expect(d.args).toEqual(["/srv/medusa/server/dist/mcp/medusa-mcp-shim.js"]);
    expect(resolveShimPath()).toBe("/srv/medusa/server/dist/mcp/medusa-mcp-shim.js");
  });

  it("falls back to the default sibling-file resolution when neither env var is set", () => {
    delete process.env.MEDUSA_MCP_SHIM_BIN;
    delete process.env.MEDUSA_MCP_SHIM_PATH;

    const d = buildMedusaMcpDescriptor(baseOpts());

    expect(d.command).toBe("node");
    expect(path.isAbsolute(d.args[0]!)).toBe(true);
    expect(path.basename(d.args[0]!)).toBe("medusa-mcp-shim.js");
    expect(d.args[0]).toBe(resolveShimPath());
  });
});
