import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * descriptorForSession's graceful-degradation path: when the resolved shim
 * target (a `node <script>` pair, or a bundled `MEDUSA_MCP_SHIM_BIN` binary)
 * doesn't actually exist on disk, the whole point is that engines still get
 * spawned -- just without --mcp-config -- instead of failing their entire
 * turn the way the bug this guards against does (a bun-compiled sidecar
 * whose shim path resolves inside its own virtual filesystem). So this
 * mocks `fs.existsSync` rather than touching real files.
 */

const existsSyncMock = vi.fn();

vi.mock("fs", () => ({
  default: { existsSync: (...args: unknown[]) => existsSyncMock(...args) },
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

vi.mock("../../config.js", () => ({
  default: { authToken: "tok-abc", port: 3456 },
}));

const { descriptorForSession } = await import("../config.js");

describe("descriptorForSession", () => {
  const savedBin = process.env.MEDUSA_MCP_SHIM_BIN;
  const savedPath = process.env.MEDUSA_MCP_SHIM_PATH;

  beforeEach(() => {
    existsSyncMock.mockReset();
    delete process.env.MEDUSA_MCP_SHIM_BIN;
    process.env.MEDUSA_MCP_SHIM_PATH = "/srv/medusa/server/dist/mcp/medusa-mcp-shim.js";
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.MEDUSA_MCP_SHIM_BIN;
    else process.env.MEDUSA_MCP_SHIM_BIN = savedBin;
    if (savedPath === undefined) delete process.env.MEDUSA_MCP_SHIM_PATH;
    else process.env.MEDUSA_MCP_SHIM_PATH = savedPath;
  });

  it("returns a descriptor when the shim script and node both exist", () => {
    existsSyncMock.mockReturnValue(true); // shim script exists; every PATH dir "has" node

    const d = descriptorForSession("sess-1");

    expect(d).not.toBeNull();
    expect(d!.command).toBe("node");
  });

  it("returns null and warns when the shim script is missing (node CLI case)", () => {
    existsSyncMock.mockReturnValue(false);
    const warnings: string[] = [];

    const d = descriptorForSession("sess-1", {}, (msg) => warnings.push(msg));

    expect(d).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("medusa-mcp-shim.js");
  });

  it("returns null and warns when the bundled shim binary is missing", () => {
    process.env.MEDUSA_MCP_SHIM_BIN = "/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim";
    existsSyncMock.mockReturnValue(false);
    const warnings: string[] = [];

    const d = descriptorForSession("sess-1", {}, (msg) => warnings.push(msg));

    expect(d).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim");
  });

  it("returns a descriptor for the bundled binary case when it exists", () => {
    process.env.MEDUSA_MCP_SHIM_BIN = "/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim";
    existsSyncMock.mockReturnValue(true);

    const d = descriptorForSession("sess-1");

    expect(d).not.toBeNull();
    expect(d!.command).toBe("/Applications/Medusa.app/Contents/MacOS/medusa-mcp-shim");
    expect(d!.args).toEqual([]);
  });

  it("does not call onWarning when it succeeds", () => {
    existsSyncMock.mockReturnValue(true);
    const onWarning = vi.fn();

    descriptorForSession("sess-1", {}, onWarning);

    expect(onWarning).not.toHaveBeenCalled();
  });
});
