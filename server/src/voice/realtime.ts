/**
 * Live mode (S16, item 4): hand the spoken conversation to a realtime speech
 * model, and keep the orchestration in Medusa.
 *
 * The normal loop is STT -> engine -> TTS, three round trips Medusa owns. A
 * realtime model collapses all three into one socket: audio in, audio out, and
 * the model itself decides when to talk. What it must NOT do is take over the
 * work, so every one of Medusa's MCP tools (`spawn_agent`, `agent_status`,
 * `agent_result`, `list_agents`, `cancel_agent`) is handed to it as a function
 * definition and every call is bridged straight to the same HTTP endpoints the
 * MCP shim uses. The realtime model talks; the SubagentManager still works.
 *
 * Both sides' transcripts come back out as events so `voice-handlers.ts` can
 * post them into the chat as ordinary messages.
 *
 * Status: the provider below is written against the documented OpenAI Realtime
 * WebSocket protocol and is fully exercised by unit tests through an injected
 * fake socket (`__tests__/realtime.test.ts`), including the function-call
 * bridge. It has NOT been run against the live service: this machine has no
 * OpenAI key in the providers settings, so Settings > Voice shows Live mode
 * disabled with that explanation until one is added.
 */

import { callMedusa, type ShimEnv } from "../mcp/client.js";
import { ALL_MCP_TOOLS, type McpToolSpec } from "../mcp/tools.js";
import type { MinimalWebSocket, WebSocketFactory } from "./streaming-stt.js";

export type RealtimeState = "connecting" | "listening" | "thinking" | "speaking" | "closed";

export interface RealtimeHandlers {
  /** Final transcript of what the user said; posted as a user message. */
  onUserTranscript?: (text: string) => void;
  /** Final transcript of what she said; posted as an assistant message. */
  onAssistantTranscript?: (text: string) => void;
  /** Audio to play, base64, in order. */
  onAudio?: (chunk: { seq: number; mime: string; data: string }) => void;
  /** The model started a new response: stop any audio still playing. */
  onInterrupt?: () => void;
  onState?: (state: RealtimeState) => void;
  /** One line for the Activity Log (tool calls, mostly). */
  onActivity?: (summary: string, detail?: string) => void;
  onError?: (err: Error) => void;
}

export interface RealtimeSession {
  /** 16 kHz mono PCM16 from the mic. */
  pushAudio(pcm: Int16Array): void;
  /** Push-to-talk release: ask for a response now. */
  commit(): void;
  /** Barge-in / the interrupt button. */
  interrupt(): void;
  close(): void;
}

export interface RealtimeOpenOptions extends RealtimeHandlers {
  /** Spoken-style instructions, usually the orchestrator prompt's voice part. */
  instructions?: string;
  voice?: string;
  /** How to reach Medusa's own HTTP API for tool calls. */
  tools: ShimEnv;
  /** Tool specs to expose. Defaults to every Medusa MCP tool. */
  toolSpecs?: McpToolSpec[];
}

export interface RealtimeVoiceProvider {
  readonly id: string;
  readonly displayName: string;
  /** False when no key is configured; Settings explains why it is disabled. */
  isReady(): boolean;
  open(options: RealtimeOpenOptions): RealtimeSession;
}

/**
 * Translate Medusa's MCP tool specs into OpenAI Realtime function
 * definitions. The shapes are close enough that this is a rename: `name`,
 * `description` and a JSON Schema `parameters`.
 */
export function toRealtimeFunctions(
  specs: McpToolSpec[] = ALL_MCP_TOOLS
): Array<Record<string, unknown>> {
  return specs.map((spec) => ({
    type: "function",
    name: spec.name,
    description: spec.description,
    parameters: {
      type: "object",
      properties: spec.inputSchema.properties,
      ...(spec.inputSchema.required ? { required: spec.inputSchema.required } : {}),
    },
  }));
}

/**
 * Run one function call the model asked for, against Medusa's HTTP API.
 * Returns the JSON text to hand back as the function output. Never throws: a
 * failed tool has to come back as text the model can talk about.
 */
export async function runRealtimeFunction(
  spec: McpToolSpec | undefined,
  rawArgs: string,
  shim: ShimEnv,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!spec) return JSON.stringify({ error: "Unknown tool" });
  let args: Record<string, unknown> = {};
  if (rawArgs && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return JSON.stringify({ error: `Could not parse arguments for ${spec.name}` });
    }
  }
  const missing = (spec.inputSchema.required ?? []).filter(
    (key) => args[key] === undefined || args[key] === null || args[key] === ""
  );
  if (missing.length > 0) {
    return JSON.stringify({ error: `${spec.name} is missing: ${missing.join(", ")}` });
  }
  const result = await callMedusa(shim, spec, args, fetchImpl);
  return result.text;
}

export interface OpenAiRealtimeOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests; defaults to the WebSocket built into Node. */
  createSocket?: WebSocketFactory;
  fetchImpl?: typeof fetch;
}

export const OPENAI_REALTIME_MODEL = "gpt-realtime";

/**
 * OpenAI Realtime over a server-side WebSocket.
 *
 * Auth uses the subprotocol form rather than an Authorization header, because
 * the WebSocket built into Node 22 accepts subprotocols but not headers, and
 * adding a `ws` dependency for one optional feature was not worth it.
 */
export class OpenAiRealtimeProvider implements RealtimeVoiceProvider {
  readonly id = "openai-realtime";
  readonly displayName = "OpenAI Realtime";

  constructor(private readonly options: OpenAiRealtimeOptions) {}

  isReady(): boolean {
    return Boolean(this.options.apiKey);
  }

  open(opts: RealtimeOpenOptions): RealtimeSession {
    const model = this.options.model ?? OPENAI_REALTIME_MODEL;
    const create =
      this.options.createSocket ??
      ((url: string, protocols?: string[]) =>
        new (globalThis as any).WebSocket(url, protocols) as MinimalWebSocket);

    const socket = create(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      ["realtime", `openai-insecure-api-key.${this.options.apiKey}`, "openai-beta.realtime-v1"]
    );

    const specs = opts.toolSpecs ?? ALL_MCP_TOOLS;
    const byName = new Map(specs.map((s) => [s.name, s]));
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let open = false;
    let seq = 0;
    let closed = false;
    const backlog: string[] = [];
    let assistantText = "";

    const send = (payload: Record<string, unknown>): void => {
      const line = JSON.stringify(payload);
      if (!open) backlog.push(line);
      else socket.send(line);
    };

    opts.onState?.("connecting");

    socket.addEventListener("open", () => {
      open = true;
      // One session.update carries the whole contract: audio format, server
      // side turn detection, transcription of the user's own audio (so the
      // chat history stays complete), and the Medusa tool surface.
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: opts.instructions ?? "",
            voice: opts.voice ?? "alloy",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", silence_duration_ms: 600 },
            tools: toRealtimeFunctions(specs),
            tool_choice: "auto",
          },
        })
      );
      for (const line of backlog.splice(0)) socket.send(line);
      opts.onState?.("listening");
    });

    socket.addEventListener("error", () => {
      opts.onError?.(new Error("Realtime socket error"));
    });

    socket.addEventListener("close", () => {
      closed = true;
      opts.onState?.("closed");
    });

    socket.addEventListener("message", (event: { data?: unknown }) => {
      let msg: any;
      try {
        msg = JSON.parse(String(event.data ?? ""));
      } catch {
        return;
      }
      switch (msg.type) {
        case "input_audio_buffer.speech_started":
          // The model heard the user start: whatever is playing is now stale.
          opts.onInterrupt?.();
          opts.onState?.("listening");
          break;

        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript) opts.onUserTranscript?.(String(msg.transcript).trim());
          break;

        case "response.created":
          assistantText = "";
          opts.onState?.("thinking");
          break;

        case "response.audio.delta":
        case "response.output_audio.delta":
          if (typeof msg.delta === "string" && msg.delta) {
            opts.onState?.("speaking");
            opts.onAudio?.({ seq: seq++, mime: "audio/pcm;rate=24000", data: msg.delta });
          }
          break;

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
          if (typeof msg.delta === "string") assistantText += msg.delta;
          break;

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          if (typeof msg.transcript === "string") assistantText = msg.transcript;
          break;

        case "response.function_call_arguments.done": {
          const name = String(msg.name ?? "");
          const callId = String(msg.call_id ?? "");
          opts.onActivity?.(`live: ${name}`, String(msg.arguments ?? ""));
          void runRealtimeFunction(
            byName.get(name),
            String(msg.arguments ?? ""),
            opts.tools,
            fetchImpl
          )
            .then((output) => {
              if (closed) return;
              send({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output,
                },
              });
              // The model does not resume on its own after a tool result.
              send({ type: "response.create" });
            })
            .catch((err: unknown) => {
              opts.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
          break;
        }

        case "response.done":
          if (assistantText.trim()) opts.onAssistantTranscript?.(assistantText.trim());
          assistantText = "";
          opts.onState?.("listening");
          break;

        case "error":
          opts.onError?.(new Error(String(msg.error?.message ?? "Realtime error")));
          break;

        default:
          break;
      }
    });

    return {
      pushAudio: (pcm: Int16Array) => {
        if (closed || pcm.length === 0) return;
        send({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
        });
      },
      commit: () => {
        send({ type: "input_audio_buffer.commit" });
        send({ type: "response.create" });
      },
      interrupt: () => {
        send({ type: "response.cancel" });
        opts.onInterrupt?.();
      },
      close: () => {
        closed = true;
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      },
    };
  }
}

/** Providers Settings > Voice can offer, with whether each one has a key. */
export interface RealtimeProviderStatus {
  id: string;
  displayName: string;
  ready: boolean;
  /** Why it is unavailable, for the disabled control's tooltip. */
  reason?: string;
}
