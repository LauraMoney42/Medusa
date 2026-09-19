import fs from "fs";
import type { McpToolSpec } from "./tools.js";

/**
 * Turns one Medusa HTTP response into the MCP `content` array for a tool
 * call. Almost every tool is plain text (the JSON body, or an error
 * message), but `take_screenshot` needs to carry the captured PNG back as an
 * image content block too.
 *
 * Kept free of the MCP SDK (same reason as client.ts): the shim imports the
 * SDK's types for its own request handler, but this module is plain data in
 * and data out, so it is trivial to unit test without spinning up a real MCP
 * `Server`/transport pair.
 *
 * Whether an engine's CLI actually renders an inline image content block
 * back to its model varies: the `claude` CLI is itself an MCP client, so a
 * `type: "image"` block reaches the model directly. Kimi's and ACP's tool
 * result parsers (kimi-cli-engine.ts, acp-engine.ts) currently keep only
 * `type: "text"` blocks and silently drop anything else. Rather than
 * threading "which engine is asking" through the shim (it is deliberately
 * generic across every engine), the text confirmation always stands on its
 * own and always names the saved path, so an engine that cannot preview the
 * image still gets a usable, non-broken answer.
 */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallResult {
  content: ToolContentBlock[];
  isError: boolean;
}

interface ScreenshotResponse {
  filePath: string;
  absolutePath: string;
  width: number;
  height: number;
  target: string;
}

function isScreenshotResponse(v: unknown): v is ScreenshotResponse {
  const r = v as Partial<ScreenshotResponse> | null;
  return (
    !!r &&
    typeof r.filePath === "string" &&
    typeof r.absolutePath === "string" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  );
}

export interface BuildToolResultOptions {
  /** Injectable for tests; defaults to fs.readFileSync. */
  readFile?: (path: string) => Buffer;
}

/**
 * `spec` identifies which tool was called, `callResult` is what `callMedusa`
 * got back from the Medusa HTTP route (its raw text plus whether the HTTP
 * call failed).
 */
export function buildToolResultContent(
  spec: McpToolSpec,
  callResult: { text: string; isError: boolean },
  opts: BuildToolResultOptions = {}
): ToolCallResult {
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p));

  if (spec.name !== "take_screenshot" || callResult.isError) {
    return { content: [{ type: "text", text: callResult.text }], isError: callResult.isError };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(callResult.text);
  } catch {
    return { content: [{ type: "text", text: callResult.text }], isError: false };
  }

  if (!isScreenshotResponse(parsed)) {
    return { content: [{ type: "text", text: callResult.text }], isError: false };
  }

  const { filePath, absolutePath, width, height } = parsed;
  const confirmation = `Screenshot captured (${width}x${height}), saved to ${filePath}.`;

  try {
    const bytes = readFile(absolutePath);
    return {
      content: [
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
        { type: "text", text: confirmation },
      ],
      isError: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text:
            `${confirmation} The image was saved but could not be attached as a preview ` +
            `in this engine (${reason}). Open the file directly to view it.`,
        },
      ],
      isError: false,
    };
  }
}
