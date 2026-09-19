/**
 * Gemini Live: true speech-to-speech behind `RealtimeVoiceProvider`.
 *
 * The S14 pipeline is three round trips Medusa owns (Whisper -> engine ->
 * Kokoro). This is one socket: 16 kHz PCM16 goes up, 24 kHz PCM16 comes back,
 * and the model itself decides when to talk and when to stop because the user
 * started talking. What it must NOT do is take the orchestration away, so
 * every Medusa MCP tool is handed over as a Gemini function declaration and
 * every call it makes is executed against Medusa's own HTTP API through
 * `mcp/client.ts`. She talks; the SubagentManager still runs the work.
 *
 * Protocol facts this file is written against (verified 2026-09-18 against
 * ai.google.dev/api/live, /gemini-api/docs/live, /live-guide and /live-tools):
 *
 *   endpoint  wss://generativelanguage.googleapis.com/ws/
 *             google.ai.generativelanguage.v1beta.GenerativeService.
 *             BidiGenerateContent?key=<API_KEY>
 *   first     {"setup": {...}}, and nothing else may be sent until the server
 *             answers {"setupComplete": {}}.
 *   audio in  {"realtimeInput": {"audio": {"data": <base64>,
 *             "mimeType": "audio/pcm;rate=16000"}}} -- raw, little-endian,
 *             16-bit mono PCM.
 *   audio out serverContent.modelTurn.parts[].inlineData, 24 kHz PCM16.
 *   barge-in  serverContent.interrupted === true. The model detects it with
 *             its own VAD; the client just has to stop playing.
 *   tools     setup.tools[].functionDeclarations, calls arrive as
 *             {"toolCall": {"functionCalls": [{id, name, args}]}} and are
 *             answered with {"toolResponse": {"functionResponses":
 *             [{id, name, response}]}}. The Live API does no automatic tool
 *             handling: answering is entirely our job.
 *   text      {"clientContent": {"turns": [...], "turnComplete": true}} is how
 *             a non-spoken turn (a subagent follow-up) is injected.
 *
 * NOT verified against the live service: this machine has no Gemini key, so
 * every assertion above comes from the published protocol reference and is
 * exercised only through an injected fake socket in the tests.
 */

import { callMedusa, type ShimEnv } from "../../mcp/client.js";
import { ALL_MCP_TOOLS, type McpToolSpec } from "../../mcp/tools.js";
import type { MinimalWebSocket, WebSocketFactory } from "../streaming-stt.js";
import type {
  RealtimeOpenOptions,
  RealtimeSession,
  RealtimeVoiceProvider,
} from "../realtime.js";

/** The one BidiGenerateContent endpoint. The key travels as a query param. */
export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Native audio dialog. This is the model the owner's free AI Studio key
 * lists, and the only tier that is genuinely speech-to-speech rather than a
 * cascade with a speech skin.
 */
export const GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

/** Input is 16 kHz because that is what `MicCapture` already produces. */
export const GEMINI_INPUT_RATE = 16_000;
/** Output is fixed at 24 kHz by the API. */
export const GEMINI_OUTPUT_RATE = 24_000;

/** Prebuilt voice. Chosen to sit near Kokoro's `af_heart` default. */
export const GEMINI_DEFAULT_VOICE = "Aoede";

/** Voices the Live API accepts; anything else is rejected with close code 1007. */
export const GEMINI_VOICES = ["Aoede", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Zephyr"] as const;

/** Map a requested speaker to a Gemini voice, falling back to the default. */
export function resolveGeminiVoice(requested: string | undefined): string {
  if (!requested) return GEMINI_DEFAULT_VOICE;
  const hit = GEMINI_VOICES.find((v) => v.toLowerCase() === requested.toLowerCase());
  return hit ?? GEMINI_DEFAULT_VOICE;
}

// ---- JSON Schema -> Gemini Schema --------------------------------------

/**
 * Gemini's function declarations take an OpenAPI-flavoured Schema whose
 * `type` is a proto enum, so it must be spelled in upper case, and which
 * rejects the JSON Schema keywords Medusa's specs happen to carry (`default`
 * is the one that actually appears, on `spawn_agent.wait`). Translating here
 * rather than loosening the specs keeps `mcp/tools.ts` the single description
 * of the tool surface.
 */
export function toGeminiSchema(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object") return { type: "STRING" };
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const type = typeof src.type === "string" ? src.type.toUpperCase() : "STRING";
  out.type = type;
  if (typeof src.description === "string") out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum.map((v) => String(v));

  if (type === "OBJECT") {
    const props = (src.properties ?? {}) as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) mapped[key] = toGeminiSchema(value);
    out.properties = mapped;
    if (Array.isArray(src.required) && src.required.length > 0) {
      out.required = src.required.map((v) => String(v));
    }
  }
  if (type === "ARRAY") {
    out.items = toGeminiSchema(src.items);
  }
  return out;
}

/** Medusa's MCP tools as Gemini function declarations. */
export function toGeminiFunctionDeclarations(
  specs: McpToolSpec[] = ALL_MCP_TOOLS
): Array<Record<string, unknown>> {
  return specs.map((spec) => {
    const parameters = toGeminiSchema(spec.inputSchema);
    const decl: Record<string, unknown> = {
      name: spec.name,
      description: spec.description,
    };
    // An empty parameter object is rejected; `list_agents` takes none.
    const props = parameters.properties as Record<string, unknown> | undefined;
    if (props && Object.keys(props).length > 0) decl.parameters = parameters;
    return decl;
  });
}

// ---- Provider -----------------------------------------------------------

export interface GeminiLiveOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /** Injected in tests; defaults to the WebSocket built into Node. */
  createSocket?: WebSocketFactory;
  fetchImpl?: typeof fetch;
  /** How long a silence ends the user's turn. Matches the pipeline's VAD. */
  silenceDurationMs?: number;
}

/** Extra entry points Live mode needs beyond the shared `RealtimeSession`. */
export interface LiveRealtimeSession extends RealtimeSession {
  /**
   * Inject a turn the user did not speak (a subagent follow-up) so the model
   * says it out loud. Sent as a `clientContent` user turn, because the Live
   * API has no separate system-turn message and the system instruction is
   * fixed at setup time; the text is framed so the persona knows it is not
   * the user talking.
   */
  injectTurn(text: string): void;
}

/** The setup payload, exported so the tests can assert its shape directly. */
export function buildGeminiSetup(
  model: string,
  opts: RealtimeOpenOptions,
  tuning: { voice?: string; silenceDurationMs?: number } = {}
): Record<string, unknown> {
  const specs = opts.toolSpecs ?? ALL_MCP_TOOLS;
  return {
    setup: {
      // The API wants the fully qualified resource name.
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: {
        // No thinking for the spoken reply: it adds seconds before the first
        // word and leaks reasoning text parts. Verified accepted by
        // gemini-2.5-flash-native-audio-latest (audio only, zero text parts).
        thinkingConfig: { thinkingBudget: 0 },
        // Audio only: the spoken reply is the reply. The chat text comes from
        // output transcription instead, so there is no second generation to
        // pay for and no risk of the two diverging.
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: resolveGeminiVoice(tuning.voice) },
          },
        },
      },
      systemInstruction: { parts: [{ text: opts.instructions ?? "" }] },
      tools: [{ functionDeclarations: toGeminiFunctionDeclarations(specs) }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          // Server-side VAD is what makes barge-in feel like a conversation:
          // the model stops talking the moment it hears the user, and tells
          // us so with serverContent.interrupted.
          disabled: false,
          silenceDurationMs: tuning.silenceDurationMs ?? 600,
        },
      },
      // Both sides transcribed, so the chat history stays complete even
      // though nothing in this path ever produced text on purpose.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/**
 * Run one function call the model asked for against Medusa's HTTP API.
 * Never throws: a failed tool has to come back as something the model can
 * talk about, not as a dropped socket.
 */
export async function runGeminiFunction(
  spec: McpToolSpec | undefined,
  args: Record<string, unknown>,
  shim: ShimEnv,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (!spec) return { error: "Unknown tool" };
  const missing = (spec.inputSchema.required ?? []).filter(
    (key) => args[key] === undefined || args[key] === null || args[key] === ""
  );
  if (missing.length > 0) {
    return { error: `${spec.name} is missing: ${missing.join(", ")}` };
  }
  const result = await callMedusa(shim, spec, args, fetchImpl);
  // Gemini wants an object; the MCP layer speaks text. Hand back the parsed
  // JSON when it is JSON and the raw string otherwise.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text) as unknown;
  } catch {
    parsed = result.text;
  }
  return result.isError ? { error: result.text } : { result: parsed };
}

export class GeminiLiveProvider implements RealtimeVoiceProvider {
  readonly id = "gemini-live";
  readonly displayName = "Gemini Live (native audio)";

  constructor(private readonly options: GeminiLiveOptions) {}

  get model(): string {
    return this.options.model || GEMINI_LIVE_MODEL;
  }

  isReady(): boolean {
    return Boolean(this.options.apiKey);
  }

  open(opts: RealtimeOpenOptions): LiveRealtimeSession {
    const model = this.model;
    const create =
      this.options.createSocket ??
      ((url: string, protocols?: string[]) =>
        new (globalThis as { WebSocket: new (u: string, p?: string[]) => MinimalWebSocket })
          .WebSocket(url, protocols));

    const socket = create(
      `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.options.apiKey)}`
    );

    const specs = opts.toolSpecs ?? ALL_MCP_TOOLS;
    const byName = new Map(specs.map((s) => [s.name, s]));
    const fetchImpl = this.options.fetchImpl ?? fetch;

    // `setup` must be the first frame and nothing else may go out until
    // `setupComplete` comes back, so everything queues until then.
    let ready = false;
    let closed = false;
    let seq = 0;
    let assistantText = "";
    let userText = "";
    let sawAudioThisTurn = false;
    const backlog: string[] = [];

    const send = (payload: Record<string, unknown>): void => {
      if (closed) return;
      const line = JSON.stringify(payload);
      if (!ready) backlog.push(line);
      else socket.send(line);
    };

    const flushAssistantTurn = (): void => {
      if (assistantText.trim()) opts.onAssistantTranscript?.(assistantText.trim());
      assistantText = "";
      sawAudioThisTurn = false;
    };

    /**
     * The user's turn is over the moment she starts answering it, so her
     * words are posted as one message then rather than once per transcription
     * fragment. `turnComplete` flushes too, for a turn that produced no audio.
     */
    const flushUserTurn = (): void => {
      if (userText.trim()) opts.onUserTranscript?.(userText.trim());
      userText = "";
    };

    opts.onState?.("connecting");

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify(
          buildGeminiSetup(model, opts, {
            voice: this.options.voice ?? opts.voice,
            silenceDurationMs: this.options.silenceDurationMs,
          })
        )
      );
    });

    socket.addEventListener("error", () => {
      opts.onError?.(new Error("Gemini Live socket error"));
    });

    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      const wasClosed = closed;
      closed = true;
      opts.onState?.("closed");
      // 1000 is a clean close (our own `close()`); anything else is the
      // service dropping us and is what the tier fallback listens for.
      if (!wasClosed && event && typeof event.code === "number" && event.code !== 1000) {
        opts.onError?.(
          new Error(`Gemini Live closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`)
        );
      }
    });

    const handleFrame = (text: string): void => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(text) as Record<string, any>;
      } catch {
        return;
      }

      if (msg.setupComplete !== undefined) {
        ready = true;
        for (const line of backlog.splice(0)) socket.send(line);
        opts.onState?.("listening");
        return;
      }

      if (msg.toolCall) {
        const calls: any[] = msg.toolCall.functionCalls ?? [];
        for (const call of calls) {
          const name = String(call?.name ?? "");
          const id = call?.id === undefined ? undefined : String(call.id);
          const args = (call?.args ?? {}) as Record<string, unknown>;
          opts.onActivity?.(`live: ${name}`, JSON.stringify(args));
          void runGeminiFunction(byName.get(name), args, opts.tools, fetchImpl)
            .then((response) => {
              // The model resumes on its own once the response lands; unlike
              // OpenAI Realtime there is no second "now answer" message.
              send({
                toolResponse: {
                  functionResponses: [{ ...(id ? { id } : {}), name, response }],
                },
              });
            })
            .catch((err: unknown) => {
              opts.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
        }
        return;
      }

      const content = msg.serverContent;
      if (!content) return;

      if (content.interrupted) {
        // The user started talking over her. Whatever is queued is stale.
        //
        // Settle the half-spoken reply BEFORE announcing the interrupt: the
        // listener closes its assistant message on `onInterrupt`, so a
        // transcript arriving after that had nothing to append to and opened
        // a SECOND message holding the whole reply again. The owner saw every
        // interrupted reply twice in the chat.
        flushAssistantTurn();
        opts.onInterrupt?.();
        opts.onState?.("listening");
        return;
      }

      if (content.inputTranscription?.text) {
        // Gemini streams the user's own words as they settle; the Section 7
        // contract wants growing `voice:partial` lines and one final
        // `voice:transcript`, so this accumulates.
        userText += String(content.inputTranscription.text);
        opts.onUserPartial?.(userText.trim());
      }

      if (content.outputTranscription?.text) {
        const delta = String(content.outputTranscription.text);
        if (!assistantText) flushUserTurn();
        assistantText += delta;
        opts.onAssistantDelta?.(delta);
      }

      const parts: any[] = content.modelTurn?.parts ?? [];
      for (const part of parts) {
        const inline = part?.inlineData;
        if (inline?.data && String(inline.mimeType ?? "").startsWith("audio/")) {
          if (!sawAudioThisTurn) {
            sawAudioThisTurn = true;
            flushUserTurn();
            opts.onState?.("speaking");
          }
          opts.onAudio?.({
            seq: seq++,
            mime: `audio/pcm;rate=${GEMINI_OUTPUT_RATE}`,
            data: String(inline.data),
          });
        } else if (typeof part?.text === "string" && part.text) {
          // With responseModalities AUDIO, text parts are the model's own
          // reasoning ("why I chose this tone"), never the reply. The reply's
          // words arrive as outputTranscription. Forwarding these made Kokoro
          // read the reasoning aloud over Gemini's voice.
          opts.onActivity?.("live: model reasoning (not spoken)", part.text.slice(0, 400));
        }
      }

      if (content.turnComplete) {
        flushUserTurn();
        flushAssistantTurn();
        opts.onState?.("listening");
      }
    };

    // Frames may arrive as text, as binary, or (in a browser-shaped
    // WebSocket) as a Blob whose decode is async. Chaining keeps audio in
    // order no matter which shape the runtime picks.
    let chain: Promise<void> = Promise.resolve();
    socket.addEventListener("message", (event: { data?: unknown }) => {
      const data = event?.data;
      if (typeof data === "string") {
        handleFrame(data);
        return;
      }
      if (data instanceof Uint8Array) {
        handleFrame(Buffer.from(data).toString("utf-8"));
        return;
      }
      if (data instanceof ArrayBuffer) {
        handleFrame(Buffer.from(new Uint8Array(data)).toString("utf-8"));
        return;
      }
      const asBlob = data as { text?: () => Promise<string> } | null;
      if (asBlob && typeof asBlob.text === "function") {
        chain = chain
          .then(() => asBlob.text!())
          .then((text) => handleFrame(text))
          .catch(() => undefined);
      }
    });

    return {
      pushAudio: (pcm: Int16Array) => {
        if (closed || pcm.length === 0) return;
        send({
          realtimeInput: {
            audio: {
              data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
              mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
            },
          },
        });
      },
      commit: () => {
        // Push-to-talk release. Automatic activity detection normally closes
        // the turn on its own, so this only says "no more audio is coming".
        send({ realtimeInput: { audioStreamEnd: true } });
      },
      interrupt: () => {
        // There is no cancel message: the documented way to cut her off is to
        // start a new turn, which the model's own VAD does when real audio
        // arrives. For an interrupt raised on our side (only ever the interrupt
        // button or Escape, since Live mode runs no barge-in detector of its
        // own), stop local playback and let the next frames supersede.
        //
        // Settling the half-spoken reply here matters: the service reports
        // the SAME interruption a second or two later, and a `serverContent
        // .interrupted` arriving with this turn's transcript still buffered
        // flushed it into a second assistant message holding the whole reply
        // again. The owner saw the reply twice.
        flushAssistantTurn();
        opts.onInterrupt?.();
        opts.onState?.("listening");
      },
      injectTurn: (text: string) => {
        if (!text.trim()) return;
        send({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        });
      },
      close: () => {
        closed = true;
        try {
          socket.close(1000, "done");
        } catch {
          // Already closed.
        }
      },
    };
  }
}
