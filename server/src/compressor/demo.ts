#!/usr/bin/env npx tsx
/**
 * Smoke test for TC-1 compression engine.
 * Run: npx tsx server/src/compressor/demo.ts
 */
import { compress, type CompressionLevel } from "./engine.js";

const SAMPLE = `--- HUB ---
Great question! Here's my update on the task.

[Medusa @ 2026-02-22T10:30:00.000Z]: @Security review the auth module. Let me know if you need anything else.
[Security @ 2026-02-22T10:31:00.000Z]: Acknowledged. Starting auth review now.
[Security @ 2026-02-22T10:35:00.000Z]: Acknowledged. Starting auth review now.
[Medusa @ 2026-02-22T10:36:00.000Z]: @Security review the auth module. Let me know if you need anything else.
[Security @ 2026-02-22T10:37:00.000Z]: 🚨 APPROVAL NEEDED: auth token rotation policy

As mentioned earlier, the auth module is basically essentially the core of the system.
To be honest, it's worth noting that we should prioritize this.

Sounds good! I'll get right on it. Hope that helps!
Don't hesitate to reach out.


Active bots: Medusa, Security, Dev1, Dev2, Dev3
--- END HUB ---`;

const levels: CompressionLevel[] = ["conservative", "moderate", "aggressive"];
const preview = (s: string, n = 60) => s.length > n ? s.slice(0, n) + "..." : s;

console.log("=== TC-1 Compression Engine — Smoke Test ===\n");
console.log(`Original (${SAMPLE.length} chars, ${SAMPLE.split("\n").length} lines):`);
console.log(preview(SAMPLE, 120), "\n");

for (const level of levels) {
  const { compressed, audit } = compress(SAMPLE, level, { audit: true });
  console.log(`--- ${level.toUpperCase()} ---`);
  console.log(`  Ratio: ${((audit!.ratio) * 100).toFixed(1)}% reduction`);
  console.log(`  ${SAMPLE.length} → ${compressed.length} chars`);
  console.log(`  Removed (${audit!.removed.length} ops): ${[...new Set(audit!.removed.map(e => e.reason))].join(", ") || "none"}`);
  console.log(`  Output preview: ${preview(compressed)}\n`);
}

console.log("✅ All levels ran. Security line preserved:",
  compress(SAMPLE, "aggressive").compressed.includes("APPROVAL NEEDED"));
