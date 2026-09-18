import { ClaudeCliEngine } from "./claude-cli-engine.js";
import { KimiCliEngine } from "./kimi-cli-engine.js";
import { AcpEngine } from "./acp-engine.js";
import { createCodePuppyEngine } from "./code-puppy-engine.js";
import { createKimiAcpEngine, KIMI_WARM_ENGINE_ID } from "./kimi-acp-engine.js";
import { WarmClaudeEngine, CLAUDE_WARM_ENGINE_ID } from "./warm-claude-engine.js";
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

/**
 * Warm counterparts (S16). Same agent, long-lived process: `claude` driven
 * over its bidirectional stream-json channel, `kimi` over ACP. A session opts
 * in through ProcessManager.setWarmMode (voice turns do by default), and the
 * cold engine below stays the fallback for everything else.
 */
const WARM_ENGINE_IDS: Record<string, string> = {
  claude: CLAUDE_WARM_ENGINE_ID,
  kimi: KIMI_WARM_ENGINE_ID,
};

/**
 * The warm engine id for a cold one, or null when that engine has no warm
 * mode (code-puppy, and the warm ids themselves).
 */
export function warmEngineIdFor(id: string | null | undefined): string | null {
  if (!id) return null;
  const warm = WARM_ENGINE_IDS[id];
  if (!warm || !engines.has(warm)) return null;
  return warm;
}

/** True when this engine id is one of the warm variants. */
export function isWarmEngineId(id: string | null | undefined): boolean {
  return Boolean(id) && Object.values(WARM_ENGINE_IDS).includes(id as string);
}

/**
 * Release any long-lived agent process held for one session. Safe to call for
 * a session that never had one, so the callers (voice off, session deleted)
 * do not have to know which engine was in use.
 */
export function closeWarmProcesses(sessionId: string): void {
  for (const engine of engines.values()) {
    if (engine instanceof WarmClaudeEngine) engine.retire(sessionId, "session closed");
    else if (engine instanceof AcpEngine) engine.closeWarm(sessionId);
  }
}

/** Release every warm process (server shutdown). */
export function closeAllWarmProcesses(): void {
  for (const engine of engines.values()) {
    if (engine instanceof WarmClaudeEngine) engine.retireAll();
    else if (engine instanceof AcpEngine) engine.closeAllWarm();
  }
}

registerEngine(new ClaudeCliEngine());
registerEngine(new KimiCliEngine());
registerEngine(new WarmClaudeEngine());
registerEngine(createKimiAcpEngine());
// Code Puppy speaks the Agent Client Protocol; any other ACP agent (goose acp,
// gemini --experimental-acp) can be added here with the same AcpEngine class.
registerEngine(createCodePuppyEngine());
