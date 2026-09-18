/**
 * S16 item 1, routing half: warm mode swaps the harness for the long-lived
 * variant of the SAME engine and changes nothing else. A voice session turns
 * it on; typed chats stay on the cold path.
 */

import { describe, expect, it } from "vitest";
import { ProcessManager } from "../process-manager.js";

function manager(engineId: string): ProcessManager {
  const pm = new ProcessManager();
  pm.createSession("s1", "/tmp", true, { engineId });
  return pm;
}

describe("ProcessManager warm mode", () => {
  it("routes claude to the warm variant and back", () => {
    const pm = manager("claude");
    expect(pm.isWarmMode("s1")).toBe(false);
    expect(pm.setWarmMode("s1", true)).toBe("claude-warm");
    expect(pm.isWarmMode("s1")).toBe(true);
    expect(pm.setWarmMode("s1", false)).toBe("claude");
    expect(pm.isWarmMode("s1")).toBe(false);
  });

  it("routes kimi through its ACP engine", () => {
    const pm = manager("kimi");
    expect(pm.setWarmMode("s1", true)).toBe("kimi-warm");
  });

  it("leaves an engine with no warm variant alone", () => {
    const pm = manager("code-puppy");
    expect(pm.setWarmMode("s1", true)).toBe("code-puppy");
    expect(pm.isWarmMode("s1")).toBe(false);
  });

  it("keeps the session's provider env when the harness is swapped", () => {
    const pm = new ProcessManager();
    pm.createSession("s1", "/tmp", true, { engineId: "claude", providerId: "openrouter" });
    expect(pm.setWarmMode("s1", true)).toBe("claude-warm");
    // The provider is unchanged: warm mode is a lifecycle choice, not a
    // different model or a different account.
    expect(pm.isWarmMode("s1")).toBe(true);
  });

  it("is a no-op for an unknown session", () => {
    const pm = new ProcessManager();
    expect(pm.setWarmMode("nope", true)).toBeNull();
    expect(pm.isWarmMode("nope")).toBe(false);
  });
});
