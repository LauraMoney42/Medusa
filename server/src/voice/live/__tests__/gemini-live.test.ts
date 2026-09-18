/**
 * Gemini Live protocol conformance, against an injected fake socket.
 *
 * These tests are the only check on the wire format that exists on this
 * machine: there is no Gemini key here, so the provider has never been run
 * against the real service. Every expectation below is transcribed from the
 * published BidiGenerateContent reference (ai.google.dev/api/live and the
 * live / live-guide / live-tools pages, read 2026-09-18), so if Google
 * changes a field name these fail rather than the microphone going quiet.
 */

import { describe, expect, it, vi } from "vitest";
import {
  GeminiLiveProvider,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_URL,
  buildGeminiSetup,
  runGeminiFunction,
  toGeminiFunctionDeclarations,
  toGeminiSchema,
} from "../gemini-live.js";
import { SUBAGENT_TOOLS } from "../../../mcp/tools.js";
import type { ShimEnv } from "../../../mcp/client.js";

const shim: ShimEnv = {
  url: "http://127.0.0.1:9999",
  token: "tkn",
  parentSessionId: "s1",
  toolsets: null,
};

/** A WebSocket the test drives by hand. */
function fakeSocket() {
  const sent: any[] = [];
  const listeners = new Map<string, (e: any) => void>();
  let url = "";
  const socket = {
    readyState: 1,
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: vi.fn(),
    addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
  };
  return {
    create: (u: string) => {
      url = u;
      return socket as any;
    },
    get url() {
      return url;
    },
    sent,
    socket,
    open: () => listeners.get("open")?.({}),
    say: (msg: unknown) => listeners.get("message")?.({ data: JSON.stringify(msg) }),
    /** The same frame delivered as binary, which is also a legal transport. */
    sayBinary: (msg: unknown) =>
      listeners.get("message")?.({ data: Buffer.from(JSON.stringify(msg), "utf-8") }),
    shut: (code: number, reason = "") => listeners.get("close")?.({ code, reason }),
  };
}

describe("toGeminiSchema", () => {
  it("upper-cases proto types and drops JSON Schema keywords Gemini rejects", () => {
    const schema = toGeminiSchema({
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "what to do" },
        wait: { type: "boolean", default: true },
        engine: { type: "string", enum: ["claude", "kimi"] },
      },
    });
    expect(schema.type).toBe("OBJECT");
    expect(schema.required).toEqual(["task"]);
    const props = schema.properties as Record<string, any>;
    expect(props.task).toEqual({ type: "STRING", description: "what to do" });
    // `default` is the one JSON Schema keyword Medusa's specs carry, and the
    // Gemini Schema has no such field.
    expect(props.wait).toEqual({ type: "BOOLEAN" });
    expect(props.engine.enum).toEqual(["claude", "kimi"]);
  });
});

describe("toGeminiFunctionDeclarations", () => {
  it("exposes every Medusa subagent tool", () => {
    const decls = toGeminiFunctionDeclarations();
    expect(decls.map((d) => d.name)).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "agent_status",
        "agent_result",
        "list_agents",
        "cancel_agent",
      ])
    );
  });

  it("omits `parameters` for a tool that takes none", () => {
    const decls = toGeminiFunctionDeclarations();
    const list = decls.find((d) => d.name === "list_agents")!;
    expect(list.parameters).toBeUndefined();
    const spawn = decls.find((d) => d.name === "spawn_agent")! as any;
    expect(spawn.parameters.required).toEqual(["task"]);
  });
});

describe("buildGeminiSetup", () => {
  const setup = () =>
    (buildGeminiSetup(GEMINI_LIVE_MODEL, {
      instructions: "You are Medusa.",
      tools: shim,
      toolSpecs: SUBAGENT_TOOLS,
    }).setup as any);

  it("qualifies the model name and asks for audio out", () => {
    const s = setup();
    expect(s.model).toBe(`models/${GEMINI_LIVE_MODEL}`);
    expect(s.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName)
      .toBeTruthy();
  });

  it("carries Medusa's orchestrator prompt as the system instruction", () => {
    expect(setup().systemInstruction).toEqual({ parts: [{ text: "You are Medusa." }] });
  });

  it("turns on both transcriptions and server-side activity detection", () => {
    const s = setup();
    expect(s.inputAudioTranscription).toEqual({});
    expect(s.outputAudioTranscription).toEqual({});
    expect(s.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
    expect(s.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(600);
  });

  it("hands the tools over as functionDeclarations", () => {
    const s = setup();
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0].functionDeclarations.map((d: any) => d.name)).toContain("spawn_agent");
  });
});

describe("GeminiLiveProvider", () => {
  function open(extra: Record<string, unknown> = {}) {
    const fake = fakeSocket();
    const events: any[] = [];
    const provider = new GeminiLiveProvider({
      apiKey: "k-123",
      createSocket: fake.create,
      fetchImpl: (extra.fetchImpl as typeof fetch) ?? (vi.fn() as unknown as typeof fetch),
    });
    const session = provider.open({
      instructions: "persona",
      tools: shim,
      toolSpecs: SUBAGENT_TOOLS,
      onState: (state) => events.push({ state }),
      onUserPartial: (text) => events.push({ userPartial: text }),
      onUserTranscript: (text) => events.push({ user: text }),
      onAssistantDelta: (delta) => events.push({ delta }),
      onAssistantTranscript: (text) => events.push({ assistant: text }),
      onAudio: (chunk) => events.push({ audio: chunk }),
      onInterrupt: () => events.push({ interrupt: true }),
      onActivity: (summary) => events.push({ activity: summary }),
      onError: (err) => events.push({ error: err.message }),
    });
    return { fake, events, session };
  }

  it("connects to BidiGenerateContent with the key as a query param", () => {
    const { fake } = open();
    expect(fake.url).toBe(`${GEMINI_LIVE_URL}?key=k-123`);
  });

  it("sends setup first and holds everything else until setupComplete", () => {
    const { fake, session } = open();
    fake.open();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].setup).toBeDefined();

    // Audio pushed before the handshake settles must not jump the queue.
    session.pushAudio(Int16Array.from([1, 2, 3]));
    expect(fake.sent).toHaveLength(1);

    fake.say({ setupComplete: {} });
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
  });

  it("frames microphone audio as base64 PCM16 at 16 kHz", () => {
    const { fake, session } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    session.pushAudio(Int16Array.from([0, -1, 32767]));
    const frame = fake.sent.at(-1).realtimeInput.audio;
    expect(frame.mimeType).toBe("audio/pcm;rate=16000");
    const back = Buffer.from(frame.data, "base64");
    expect(back.readInt16LE(0)).toBe(0);
    expect(back.readInt16LE(2)).toBe(-1);
    expect(back.readInt16LE(4)).toBe(32767);
  });

  it("emits inline audio parts as ordered 24 kHz chunks", () => {
    const { fake, events } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAA=" } }] },
      },
    });
    fake.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "BBB=" } }] },
      },
    });
    const audio = events.filter((e) => e.audio).map((e) => e.audio);
    expect(audio.map((a) => a.seq)).toEqual([0, 1]);
    expect(audio[0].mime).toBe("audio/pcm;rate=24000");
    expect(events.some((e) => e.state === "speaking")).toBe(true);
  });

  it("reads a frame delivered as binary the same as a text frame", () => {
    const { fake, events } = open();
    fake.open();
    fake.sayBinary({ setupComplete: {} });
    expect(events.some((e) => e.state === "listening")).toBe(true);
  });

  it("turns transcription into one user line and one assistant line per turn", () => {
    const { fake, events } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({ serverContent: { inputTranscription: { text: "what's in " } } });
    fake.say({ serverContent: { inputTranscription: { text: "this folder" } } });
    fake.say({ serverContent: { outputTranscription: { text: "Six files" } } });
    fake.say({ serverContent: { outputTranscription: { text: ", mostly TypeScript." } } });
    fake.say({ serverContent: { turnComplete: true } });

    expect(events.filter((e) => e.user).map((e) => e.user)).toEqual([
      "what's in this folder",
    ]);
    expect(events.filter((e) => e.assistant).map((e) => e.assistant)).toEqual([
      "Six files, mostly TypeScript.",
    ]);
    expect(events.filter((e) => e.delta).map((e) => e.delta)).toEqual([
      "Six files",
      ", mostly TypeScript.",
    ]);
  });

  it("reports serverContent.interrupted as a barge-in", () => {
    const { fake, events } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAA=" } }] },
      },
    });
    fake.say({ serverContent: { interrupted: true } });
    expect(events.some((e) => e.interrupt)).toBe(true);
    // And she is listening again, not stuck in speaking.
    expect(events.at(-1)).toEqual({ state: "listening" });
  });

  /**
   * Interrupt ordering (QA, 2026-09-18). The listener closes its assistant
   * message when it hears about an interruption, so the half-spoken reply has
   * to be settled BEFORE that: a transcript flushed afterwards had nothing to
   * append to and opened a second message holding the whole reply again. The
   * owner saw every interrupted reply twice.
   */
  it("settles the half-spoken reply before reporting a service interruption", () => {
    const { fake, events } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({ serverContent: { outputTranscription: { text: "one two three" } } });
    fake.say({ serverContent: { interrupted: true } });

    const order = events.filter((e) => e.assistant !== undefined || e.interrupt);
    expect(order[0]).toEqual({ assistant: "one two three" });
    expect(order[1]).toEqual({ interrupt: true });
    expect(events.filter((e) => e.assistant !== undefined)).toHaveLength(1);
  });

  it("does not report the same reply again when the service confirms our own interrupt", () => {
    const { fake, events, session } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({ serverContent: { outputTranscription: { text: "one two three" } } });

    // The client heard the user talk over her and cut her off locally...
    session.interrupt();
    // ...and a second later the service reports the same interruption.
    fake.say({ serverContent: { interrupted: true } });

    expect(events.filter((e) => e.assistant !== undefined)).toEqual([
      { assistant: "one two three" },
    ]);
  });

  it("runs a function call against Medusa and answers with a toolResponse", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "a1" }), { status: 200 })
    ) as unknown as typeof fetch;
    const { fake, events } = open({ fetchImpl });
    fake.open();
    fake.say({ setupComplete: {} });
    fake.say({
      toolCall: {
        functionCalls: [{ id: "fc-1", name: "spawn_agent", args: { task: "count files" } }],
      },
    });
    await vi.waitFor(() => expect(fake.sent.at(-1).toolResponse).toBeDefined());

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://127.0.0.1:9999/api/subagents");
    // The parent chat travels in a header, never as a tool argument.
    expect(call[1].headers["x-medusa-parent-session-id"]).toBe("s1");

    const answer = fake.sent.at(-1).toolResponse.functionResponses[0];
    expect(answer).toEqual({
      id: "fc-1",
      name: "spawn_agent",
      response: { result: { agent_id: "a1" } },
    });
    expect(events.some((e) => e.activity === "live: spawn_agent")).toBe(true);
  });

  it("injects a follow-up as a completed clientContent turn", () => {
    const { fake, session } = open();
    fake.open();
    fake.say({ setupComplete: {} });
    (session as any).injectTurn("[Agent counter done] 412 files.");
    const turn = fake.sent.at(-1).clientContent;
    expect(turn.turnComplete).toBe(true);
    expect(turn.turns[0].role).toBe("user");
    expect(turn.turns[0].parts[0].text).toContain("412 files");
  });

  it("reports an unclean close as an error so the tier can fall back", () => {
    const { fake, events } = open();
    fake.open();
    fake.shut(1011, "quota");
    expect(events.some((e) => typeof e.error === "string" && e.error.includes("1011"))).toBe(
      true
    );
  });

  it("stays quiet on a clean close", () => {
    const { fake, events, session } = open();
    fake.open();
    session.close();
    fake.shut(1000);
    expect(events.some((e) => e.error)).toBe(false);
  });
});

describe("runGeminiFunction", () => {
  it("refuses a call missing a required argument without touching the network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const spec = SUBAGENT_TOOLS.find((t) => t.name === "spawn_agent")!;
    const out = await runGeminiFunction(spec, {}, shim, fetchImpl);
    expect(out.error).toContain("task");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an unknown tool rather than throwing", async () => {
    expect(await runGeminiFunction(undefined, {}, shim)).toEqual({ error: "Unknown tool" });
  });

  it("returns a non-JSON body verbatim", async () => {
    const fetchImpl = vi.fn(async () => new Response("all good", { status: 200 })) as
      unknown as typeof fetch;
    const spec = SUBAGENT_TOOLS.find((t) => t.name === "list_agents")!;
    expect(await runGeminiFunction(spec, {}, shim, fetchImpl)).toEqual({ result: "all good" });
  });
});
