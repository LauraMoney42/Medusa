import { describe, it, expect } from "vitest";
import { buildToolResultContent } from "../tool-content.js";
import { ALL_MCP_TOOLS } from "../tools.js";

const screenshotSpec = ALL_MCP_TOOLS.find((t) => t.name === "take_screenshot")!;
const spawnSpec = ALL_MCP_TOOLS.find((t) => t.name === "spawn_agent")!;

describe("buildToolResultContent", () => {
  it("passes through plain text for every tool other than take_screenshot", () => {
    const result = buildToolResultContent(spawnSpec, {
      text: '{"agentId":"sa_1"}',
      isError: false,
    });
    expect(result).toEqual({
      content: [{ type: "text", text: '{"agentId":"sa_1"}' }],
      isError: false,
    });
  });

  it("passes through an error verbatim without trying to read a file", () => {
    const result = buildToolResultContent(screenshotSpec, {
      text: "take_screenshot failed (403): Screen Recording permission needed for medusa-server",
      isError: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "take_screenshot failed (403): Screen Recording permission needed for medusa-server",
      },
    ]);
  });

  it("attaches the PNG as a base64 image block plus a text confirmation", () => {
    const fakeBytes = Buffer.from([1, 2, 3, 4]);
    const result = buildToolResultContent(
      screenshotSpec,
      {
        text: JSON.stringify({
          filePath: "/uploads/abc.png",
          absolutePath: "/data/uploads/abc.png",
          width: 1920,
          height: 1080,
          target: "fullscreen",
          format: "png",
        }),
        isError: false,
      },
      { readFile: (p) => (p === "/data/uploads/abc.png" ? fakeBytes : Buffer.alloc(0)) }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "image", data: fakeBytes.toString("base64"), mimeType: "image/png" },
      { type: "text", text: "Screenshot captured (1920x1080), saved to /uploads/abc.png." },
    ]);
  });

  it("falls back to text-only when the file cannot be read back", () => {
    const result = buildToolResultContent(
      screenshotSpec,
      {
        text: JSON.stringify({
          filePath: "/uploads/abc.png",
          absolutePath: "/data/uploads/abc.png",
          width: 800,
          height: 600,
          target: "fullscreen",
        }),
        isError: false,
      },
      {
        readFile: () => {
          throw new Error("ENOENT: no such file");
        },
      }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Screenshot captured (800x600)");
    expect(text).toContain("saved but could not be attached as a preview");
    expect(text).toContain("/uploads/abc.png");
  });

  it("falls back to raw text when the response is not JSON or not a screenshot shape", () => {
    expect(
      buildToolResultContent(screenshotSpec, { text: "not json", isError: false })
    ).toEqual({ content: [{ type: "text", text: "not json" }], isError: false });

    expect(
      buildToolResultContent(
        screenshotSpec,
        { text: JSON.stringify({ some: "other shape" }), isError: false }
      )
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ some: "other shape" }) }],
      isError: false,
    });
  });
});
