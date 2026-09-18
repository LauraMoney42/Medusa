/**
 * S16 item 4: Live mode. The realtime model does the talking, Medusa keeps the
 * orchestration, so what these tests pin down is the tool bridge: the MCP tool
 * surface goes out as function definitions, and a function call the model makes
 * is executed against Medusa's own HTTP API and handed back as output.
 *
 * Everything runs through an injected fake socket; nothing here touches the
 * network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  OpenAiRealtimeProvider,
  runRealtimeFunction,
  toRealtimeFunctions,
} from "../realtime.js";
import { SUBAGENT_TOOLS } from "../../mcp/tools.js";
import type { ShimEnv } from "../../mcp/medusa-mcp-shim.js";

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
  const socket = {
    readyState: 1,
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: vi.fn(),
    addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
  };
  return {
    socket,
    sent,
    open: () => listeners.get("open")?.({}),
    say: (msg: unknown) => listeners.get("message")?.({ data: JSON.stringify(msg) }),
    fail: () => listeners.get("error")?.({}),
  };
}

describe("toRealtimeFunctions", () => {
  it("exposes every Medusa subagent tool as a function definition", () => {
    const fns = toRealtimeFunctions();
    const names = fns.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "agent_status",
        "agent_result",
        "list_agents",
        "cancel_agent",
      ])
    );
    const spawn = fns.find((f) => f.name === "spawn_agent") as any;
    expect(spawn.type).toBe("function");
    expect(spawn.parameters.required).toEqual(["task"]);
    expect(spawn.parameters.properties.task).toBeDefined();
  });
});

describe("runRealtimeFunction", () => {
  const spawnSpec = SUBAGENT_TOOLS.find((t) => t.name === "spawn_agent")!;

  it("calls the Medusa endpoint the tool spec names", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"agent_id":"a1"}', { status: 200 }));
    const out = await runRealtimeFunction(
      spawnSpec,
      JSON.stringify({ task: "count the files", name: "Counter" }),
      shim,
      fetchImpl as unknown as typeof fetch
    );
    expect(out).toBe('{"agent_id":"a1"}');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/api/subagents");
    expect(init.method).toBe("POST");
    // The parent session travels in a header, never as a model-supplied field.
    expect((init.headers as Record<string, string>)["x-medusa-parent-session-id"]).toBe("s1");
    expect(JSON.parse(String(init.body))).toEqual({ task: "count the files", name: "Counter" });
  });

  it("reports a missing required argument instead of calling anything", async () => {
    const fetchImpl = vi.fn();
    const out = await runRealtimeFunction(
      spawnSpec,
      "{}",
      shim,
      fetchImpl as unknown as typeof fetch
    );
    expect(JSON.parse(out).error).toContain("task");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unparseable arguments and an unknown tool", async () => {
    expect(JSON.parse(await runRealtimeFunction(spawnSpec, "{oops", shim)).error).toContain(
      "spawn_agent"
    );
    expect(JSON.parse(await runRealtimeFunction(undefined, "{}", shim)).error).toBe("Unknown tool");
  });
});

describe("OpenAiRealtimeProvider", () => {
  it("is not ready without a key", () => {
    expect(new OpenAiRealtimeProvider({ apiKey: "" }).isReady()).toBe(false);
    expect(new OpenAiRealtimeProvider({ apiKey: "sk-x" }).isReady()).toBe(true);
  });

  it("declares the Medusa tools in its session.update", () => {
    const fake = fakeSocket();
    const provider = new OpenAiRealtimeProvider({
      apiKey: "sk-x",
      createSocket: () => fake.socket as any,
    });
    provider.open({ tools: shim, instructions: "be brief" });
    fake.open();

    const update = fake.sent.find((m) => m.type === "session.update");
    expect(update.session.instructions).toBe("be brief");
    expect(update.session.input_audio_format).toBe("pcm16");
    expect(update.session.tools.map((t: any) => t.name)).toContain("spawn_agent");
  });

  it("bridges a function call to Medusa and sends the output back", async () => {
    const fake = fakeSocket();
    const fetchImpl = vi.fn(async () => new Response('{"agent_id":"a7"}', { status: 200 }));
    const activity: string[] = [];
    const provider = new OpenAiRealtimeProvider({
      apiKey: "sk-x",
      createSocket: () => fake.socket as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    provider.open({ tools: shim, onActivity: (s) => activity.push(s) });
    fake.open();

    fake.say({
      type: "response.function_call_arguments.done",
      name: "spawn_agent",
      call_id: "call_1",
      arguments: JSON.stringify({ task: "count files" }),
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(fetchImpl).toHaveBeenCalledOnce();
    const output = fake.sent.find((m) => m.type === "conversation.item.create");
    expect(output.item).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"agent_id":"a7"}',
    });
    // The model does not resume on its own after a tool result.
    expect(fake.sent.some((m) => m.type === "response.create")).toBe(true);
    expect(activity).toContain("live: spawn_agent");
  });

  it("surfaces both sides' transcripts and the audio stream", async () => {
    const fake = fakeSocket();
    const user: string[] = [];
    const assistant: string[] = [];
    const audio: string[] = [];
    const states: string[] = [];
    const interrupts = vi.fn();
    const provider = new OpenAiRealtimeProvider({
      apiKey: "sk-x",
      createSocket: () => fake.socket as any,
    });
    provider.open({
      tools: shim,
      onUserTranscript: (t) => user.push(t),
      onAssistantTranscript: (t) => assistant.push(t),
      onAudio: (c) => audio.push(c.data),
      onState: (s) => states.push(s),
      onInterrupt: interrupts,
    });
    fake.open();

    fake.say({ type: "input_audio_buffer.speech_started" });
    fake.say({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: " what files are here ",
    });
    fake.say({ type: "response.created" });
    fake.say({ type: "response.audio.delta", delta: "AAAA" });
    fake.say({ type: "response.audio_transcript.delta", delta: "Three " });
    fake.say({ type: "response.audio_transcript.delta", delta: "files." });
    fake.say({ type: "response.done" });

    expect(user).toEqual(["what files are here"]);
    expect(assistant).toEqual(["Three files."]);
    expect(audio).toEqual(["AAAA"]);
    expect(interrupts).toHaveBeenCalledOnce();
    expect(states).toContain("speaking");
    expect(states[states.length - 1]).toBe("listening");
  });

  it("queues audio sent before the socket opens", () => {
    const fake = fakeSocket();
    const provider = new OpenAiRealtimeProvider({
      apiKey: "sk-x",
      createSocket: () => fake.socket as any,
    });
    const session = provider.open({ tools: shim });
    session.pushAudio(Int16Array.from([1, 2, 3]));
    expect(fake.sent).toHaveLength(0);
    fake.open();
    expect(fake.sent.some((m) => m.type === "input_audio_buffer.append")).toBe(true);
  });
});
