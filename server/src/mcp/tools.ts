/**
 * The tool surface the `medusa` MCP server exposes, as data.
 *
 * Each spec is a pure description of one tool plus how the stdio shim reaches
 * the Medusa server for it, so the shim itself contains no per-tool code. That
 * is deliberate: per the 2026-09-17 UI and layer addendum, the same MCP
 * mechanism is meant to carry the whole Medusa tools layer (Browser via CDP,
 * Simulator via idb, local files, shell) and not only `spawn_agent`. Adding a
 * tool group means appending specs with a new `toolset` id and mounting the
 * matching Express routes; nothing in the shim changes.
 */

export type HttpMethod = "GET" | "POST";

export interface McpHttpRequest {
  method: HttpMethod;
  /** Path relative to MEDUSA_URL, already URL-encoded. */
  path: string;
  body?: Record<string, unknown>;
}

export interface McpToolSpec {
  name: string;
  /** Toolset id; the shim can be limited to a subset via MEDUSA_MCP_TOOLSETS. */
  toolset: string;
  description: string;
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<string, unknown>;
  };
  /**
   * Long-running tools hold the HTTP request open (a `spawn_agent` with
   * `wait: true` blocks until the subagent finishes), so the shim must not
   * apply its default request timeout to them.
   */
  longRunning?: boolean;
  /** Translate validated tool arguments into one Medusa HTTP call. */
  request: (args: Record<string, unknown>) => McpHttpRequest;
}

/** Path-segment escaping for ids that arrive from the model. */
function seg(value: unknown): string {
  return encodeURIComponent(String(value ?? ""));
}

export const SUBAGENT_TOOLSET = "subagents";

export const SUBAGENT_TOOLS: McpToolSpec[] = [
  {
    name: "spawn_agent",
    toolset: SUBAGENT_TOOLSET,
    description:
      "Start a subagent that works in parallel on a focused task and returns its result.",
    longRunning: true,
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description:
            "Self-contained instructions. The subagent sees none of this conversation.",
        },
        name: {
          type: "string",
          description: 'Short label shown on the card, e.g. "Audit socket events".',
        },
        engine: {
          type: "string",
          enum: ["claude", "kimi", "code-puppy"],
          description: "Defaults to the parent chat's engine.",
        },
        model: {
          type: "string",
          description: "Engine-specific model id. Defaults to the parent chat's model.",
        },
        cwd: {
          type: "string",
          description:
            "Must be inside the parent session's workingDir. Defaults to it.",
        },
        wait: {
          type: "boolean",
          default: true,
          description:
            "true: block and return the final result. false: return immediately with an agent_id.",
        },
      },
    },
    request: (args) => ({ method: "POST", path: "/api/subagents", body: args }),
  },
  {
    name: "agent_status",
    toolset: SUBAGENT_TOOLSET,
    description:
      "Current status of one subagent: state, engine, model, tool call count and token usage.",
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: {
        agent_id: { type: "string", description: "The id returned by spawn_agent." },
      },
    },
    request: (args) => ({
      method: "GET",
      path: `/api/subagents/${seg(args.agent_id)}`,
    }),
  },
  {
    name: "agent_result",
    toolset: SUBAGENT_TOOLSET,
    description:
      "Final text of a finished subagent. Blocks until it finishes if it is still running.",
    longRunning: true,
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: {
        agent_id: { type: "string", description: "The id returned by spawn_agent." },
      },
    },
    request: (args) => ({
      method: "GET",
      path: `/api/subagents/${seg(args.agent_id)}/result`,
    }),
  },
  {
    name: "list_agents",
    toolset: SUBAGENT_TOOLSET,
    description: "Every subagent spawned from this chat, with its current status.",
    inputSchema: { type: "object", properties: {} },
    request: () => ({ method: "GET", path: "/api/subagents" }),
  },
  {
    name: "cancel_agent",
    toolset: SUBAGENT_TOOLSET,
    description: "Stop a running or queued subagent.",
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: {
        agent_id: { type: "string", description: "The id returned by spawn_agent." },
      },
    },
    request: (args) => ({
      method: "POST",
      path: `/api/subagents/${seg(args.agent_id)}/cancel`,
    }),
  },
];

export const SCREENSHOT_TOOLSET = "screenshot";

export const SCREENSHOT_TOOLS: McpToolSpec[] = [
  {
    name: "take_screenshot",
    toolset: SCREENSHOT_TOOLSET,
    description:
      "Capture a screenshot of the user's screen (macOS `screencapture`) and return it as " +
      "an image plus a short text confirmation. `fullscreen` (default) always works; " +
      "`window`/`region` are interactive and best-effort, waiting on the user to click or " +
      "drag-select.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["fullscreen", "window", "region"],
          default: "fullscreen",
          description:
            "fullscreen: the whole screen, non-interactive. window: user clicks a window. " +
            "region: user drags to select an area.",
        },
      },
    },
    request: (args) => ({ method: "POST", path: "/api/screenshot", body: args }),
  },
];

/** Every tool the shim can host. Future toolsets are concatenated here. */
export const ALL_MCP_TOOLS: McpToolSpec[] = [...SUBAGENT_TOOLS, ...SCREENSHOT_TOOLS];

/** Filter by toolset id; an empty/undefined list means "everything". */
export function selectTools(toolsets?: string[] | null): McpToolSpec[] {
  if (!toolsets || toolsets.length === 0) return ALL_MCP_TOOLS;
  const wanted = new Set(toolsets);
  return ALL_MCP_TOOLS.filter((t) => wanted.has(t.toolset));
}
