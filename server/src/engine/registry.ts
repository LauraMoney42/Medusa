import { ClaudeCliEngine } from "./claude-cli-engine.js";
import { KimiCliEngine } from "./kimi-cli-engine.js";
import type { Engine } from "./types.js";

const engines = new Map<string, Engine>();

export function registerEngine(engine: Engine): void {
  engines.set(engine.id, engine);
}

export function getEngine(id: string): Engine | undefined {
  return engines.get(id);
}

/** Claude is the fallback so an unknown provider id behaves as before. */
export function getEngineOrDefault(id: string | null | undefined): Engine {
  return (id ? engines.get(id) : undefined) ?? engines.get("claude")!;
}

export function listEngines(): Engine[] {
  return [...engines.values()];
}

registerEngine(new ClaudeCliEngine());
registerEngine(new KimiCliEngine());
