import { describe, it, expect } from "vitest";
import {
  PACK_FORMAT_VERSION,
  ThemeSchema,
  ToolboxSchema,
  VoiceSchema,
  packSlug,
  parsePack,
} from "../schema.js";

/** The smallest pack that should validate. */
function goodPack(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: PACK_FORMAT_VERSION,
    manifest: { name: "Midnight Medusa", version: "1.2.0", author: "kind", description: "", license: "MIT" },
    persona: { name: "Medusa", greeting: "Ready when you are.", personality: "You are Medusa.", avatar: null },
    rules: [{ name: "adhd-mode.md", content: "Short, action-first replies.", enabled: true }],
    theme: {},
    voice: {},
    toolbox: {},
    ...overrides,
  };
}

describe("pack schema: good packs", () => {
  it("accepts a complete pack and fills the defaults", () => {
    const result = parsePack(goodPack());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.manifest.name).toBe("Midnight Medusa");
    expect(result.pack.theme.accent).toBe("#1a7a3c");
    expect(result.pack.theme.mode).toBe("dark");
    expect(result.pack.voice.voiceId).toBe("af_heart");
    expect(result.pack.toolbox.servers).toEqual([]);
    expect(result.pack.rules[0].enabled).toBe(true);
  });

  it("accepts an empty rule set", () => {
    expect(parsePack(goodPack({ rules: [] })).ok).toBe(true);
  });

  it("accepts a base64 png avatar", () => {
    const pack = goodPack({
      persona: {
        name: "Medusa",
        greeting: "",
        personality: "You are Medusa.",
        avatar: "data:image/png;base64,iVBORw0KGgo=",
      },
    });
    expect(parsePack(pack).ok).toBe(true);
  });
});

describe("pack schema: bad packs", () => {
  it("rejects a non-object", () => {
    for (const input of [null, "pack", 7, []]) {
      expect(parsePack(input).ok).toBe(false);
    }
  });

  it("rejects an unknown format version", () => {
    const result = parsePack(goodPack({ formatVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("formatVersion");
  });

  it("rejects a manifest with no name", () => {
    const result = parsePack(goodPack({ manifest: { version: "1.0.0" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("manifest.name");
  });

  it("rejects a rule file name that could escape the rules directory", () => {
    for (const name of ["../../evil.md", "rules/nested.md", ".hidden.md", "plain.txt"]) {
      const result = parsePack(goodPack({ rules: [{ name, content: "x", enabled: true }] }));
      expect(result.ok, name).toBe(false);
    }
  });

  it("rejects a non-hex theme color", () => {
    const result = parsePack(goodPack({ theme: { accent: "red" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("theme.accent");
  });

  it("rejects an svg avatar, which could carry script", () => {
    const result = parsePack(
      goodPack({
        persona: {
          name: "M",
          greeting: "",
          personality: "p",
          avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        },
      })
    );
    expect(result.ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const result = parsePack(goodPack({ manifest: {}, theme: { background: "nope" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe("theme, voice and toolbox validation", () => {
  it("accepts three and six digit hex", () => {
    expect(ThemeSchema.parse({ accent: "#abc" }).accent).toBe("#abc");
    expect(ThemeSchema.parse({ accent: "#AABBCC" }).accent).toBe("#AABBCC");
  });

  it("rejects a color with no hash, a short form, or a css name", () => {
    for (const bad of ["1a7a3c", "#12", "rebeccapurple", "#12345g"]) {
      expect(ThemeSchema.safeParse({ accent: bad }).success, bad).toBe(false);
    }
  });

  it("rejects an unknown theme mode and density", () => {
    expect(ThemeSchema.safeParse({ mode: "sepia" }).success).toBe(false);
    expect(ThemeSchema.safeParse({ density: "roomy" }).success).toBe(false);
  });

  it("clamps voice speed and pitch to a sane range", () => {
    expect(VoiceSchema.safeParse({ speed: 0.2 }).success).toBe(false);
    expect(VoiceSchema.safeParse({ pitch: 9 }).success).toBe(false);
    expect(VoiceSchema.parse({ speed: 1.5, pitch: 0.8 }).speed).toBe(1.5);
  });

  it("only allows the three permission scopes", () => {
    expect(ToolboxSchema.safeParse({ servers: [{ id: "git", scope: "root" }] }).success).toBe(false);
    const ok = ToolboxSchema.parse({ servers: [{ id: "git", scope: "shell" }] });
    expect(ok.servers[0].scope).toBe("shell");
    expect(ok.servers[0].enabled).toBe(true);
  });

  it("defaults a toolbox entry to the narrowest scope", () => {
    expect(ToolboxSchema.parse({ skills: [{ id: "review" }] }).skills[0].scope).toBe("read");
  });
});

describe("packSlug", () => {
  it("makes a safe file stem", () => {
    expect(packSlug({ name: "Midnight Medusa!", version: "1", author: "", description: "", license: "" })).toBe(
      "midnight-medusa"
    );
    expect(packSlug({ name: "///", version: "1", author: "", description: "", license: "" })).toBe("pack");
  });
});
