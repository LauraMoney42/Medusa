#!/usr/bin/env npx tsx
/**
 * CLI tool to read and aggregate token usage from the JSONL log.
 *
 * Usage:
 *   npx tsx server/src/utils/token-report.ts [--since 24h|7d|30d]
 *
 * Reads ~/.claude-chat/token-usage.jsonl (or TOKEN_USAGE_LOG_FILE env var)
 * and prints an aggregated report to stdout.
 */

import fs from "fs";
import path from "path";
import type { TokenUsageEntry } from "../metrics/token-logger.js";

const LOG_PATH =
  process.env.TOKEN_USAGE_LOG_FILE ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "token-usage.jsonl"
  );

function parseSinceArg(): Date {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx === -1 || sinceIdx + 1 >= args.length) {
    // Default: last 24 hours
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  const val = args[sinceIdx + 1];
  const match = val.match(/^(\d+)(h|d)$/);
  if (!match) {
    console.error(`Invalid --since value: "${val}". Use e.g. 24h, 7d, 30d`);
    process.exit(1);
  }

  const num = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === "h" ? num * 60 * 60 * 1000 : num * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

function readEntries(since: Date): TokenUsageEntry[] {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`Log file not found: ${LOG_PATH}`);
    return [];
  }

  const raw = fs.readFileSync(LOG_PATH, "utf-8");
  const entries: TokenUsageEntry[] = [];
  const sinceTime = since.getTime();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as TokenUsageEntry;
      if (new Date(entry.timestamp).getTime() >= sinceTime) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function printReport(entries: TokenUsageEntry[], since: Date): void {
  if (entries.length === 0) {
    console.log(`\nNo entries found since ${since.toISOString()}\n`);
    return;
  }

  // Aggregations
  let totalCost = 0;
  let totalDuration = 0;
  let successCount = 0;
  const bySession: Record<string, { title: string; cost: number; count: number; duration: number; inputTokens: number; outputTokens: number }> = {};
  const bySubagent: Record<string, { engine: string; model: string | null; task: string; cost: number; count: number; inputTokens: number; outputTokens: number }> = {};
  const bySource: Record<string, { cost: number; count: number; inputTokens: number; outputTokens: number }> = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let entriesWithTokens = 0;
  const byModel: Record<string, { cost: number; count: number }> = {};

  for (const e of entries) {
    totalCost += e.costUsd;
    totalDuration += e.durationMs;
    if (e.success) successCount++;

    const inputTokens = e.inputTokens ?? 0;
    const outputTokens = e.outputTokens ?? 0;
    if (e.inputTokens !== undefined || e.outputTokens !== undefined) {
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      entriesWithTokens++;
    }

    const sid = e.sessionId || "unknown";
    const title = e.sessionTitle || e.botName || sid;
    if (!bySession[sid]) bySession[sid] = { title, cost: 0, count: 0, duration: 0, inputTokens: 0, outputTokens: 0 };
    bySession[sid].cost += e.costUsd;
    bySession[sid].count += 1;
    bySession[sid].duration += e.durationMs;
    bySession[sid].inputTokens += inputTokens;
    bySession[sid].outputTokens += outputTokens;

    if (e.role === "subagent" && e.agentId) {
      if (!bySubagent[e.agentId]) {
        bySubagent[e.agentId] = {
          engine: e.provider || "unknown",
          model: e.model ?? null,
          task: (e.subagentTask ?? "").trim().slice(0, 140),
          cost: 0,
          count: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      bySubagent[e.agentId].cost += e.costUsd;
      bySubagent[e.agentId].count += 1;
      bySubagent[e.agentId].inputTokens += inputTokens;
      bySubagent[e.agentId].outputTokens += outputTokens;
    }

    if (!bySource[e.source]) bySource[e.source] = { cost: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    bySource[e.source].cost += e.costUsd;
    bySource[e.source].count += 1;
    bySource[e.source].inputTokens += inputTokens;
    bySource[e.source].outputTokens += outputTokens;
    const modelKey = e.provider && e.model ? `${e.provider}/${e.model}` : e.model || e.provider || "unknown";
    if (!byModel[modelKey]) byModel[modelKey] = { cost: 0, count: 0 };
    byModel[modelKey].cost += e.costUsd;
    byModel[modelKey].count += 1;
  }

  const timeSpanMs =
    new Date(entries[entries.length - 1].timestamp).getTime() -
    new Date(entries[0].timestamp).getTime();
  const timeSpanHours = Math.max(timeSpanMs / (1000 * 60 * 60), 1);

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║         TOKEN USAGE REPORT                   ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  console.log(`Period:        Since ${since.toISOString()}`);
  console.log(`Total entries: ${entries.length}`);
  console.log(`Success rate:  ${((successCount / entries.length) * 100).toFixed(1)}%`);
  console.log(`Total cost:    ${formatCost(totalCost)}`);
  console.log(`Avg cost/msg:  ${formatCost(totalCost / entries.length)}`);
  if (entriesWithTokens > 0) {
    console.log(`Input tokens:  ${totalInputTokens.toLocaleString()}  (${entriesWithTokens} entries)`);
    console.log(`Output tokens: ${totalOutputTokens.toLocaleString()}  (${entriesWithTokens} entries)`);
    console.log(`Avg in+out:    ${((totalInputTokens + totalOutputTokens) / entriesWithTokens).toFixed(0)} tokens/msg`);
  }
  console.log(`Total time:    ${formatDuration(totalDuration)}`);
  console.log(`Avg time/msg:  ${formatDuration(totalDuration / entries.length)}`);
  console.log(`Msgs/hour:     ${(entries.length / timeSpanHours).toFixed(1)}`);

  // Cost by session
  console.log("\n── Cost by Session ──────────────────────────");
  const sessionEntries = Object.entries(bySession).sort((a, b) => b[1].cost - a[1].cost);
  for (const [, data] of sessionEntries) {
    const pct = ((data.cost / totalCost) * 100).toFixed(1);
    const tokenInfo = data.inputTokens + data.outputTokens > 0
      ? `  ${(data.inputTokens + data.outputTokens).toLocaleString()} tokens`
      : "";
    console.log(
      `  ${data.title.padEnd(20)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs  avg ${formatDuration(data.duration / data.count)}${tokenInfo}`
    );
  }

  // Cost by subagent
  if (Object.keys(bySubagent).length > 0) {
    console.log("\n── Cost by Subagent ─────────────────────────");
    const subagentEntries = Object.entries(bySubagent).sort((a, b) => b[1].cost - a[1].cost);
    for (const [agentId, data] of subagentEntries) {
      const pct = ((data.cost / totalCost) * 100).toFixed(1);
      console.log(
        `  ${agentId.padEnd(14)} ${(data.engine + "/" + (data.model ?? "?")).padEnd(20)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs  ${data.task}`
      );
    }
  }

  // Cost by source
  console.log("\n── Cost by Source ───────────────────────────");
  const sourceEntries = Object.entries(bySource).sort((a, b) => b[1].cost - a[1].cost);
  for (const [source, data] of sourceEntries) {
    const pct = ((data.cost / totalCost) * 100).toFixed(1);
    const tokenInfo = data.inputTokens + data.outputTokens > 0
      ? `  ${(data.inputTokens + data.outputTokens).toLocaleString()} tokens`
      : "";
    console.log(
      `  ${source.padEnd(20)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs${tokenInfo}`
    );
  }

  // Cost by model (provider/model, e.g. "openrouter/openai/gpt-5.1")
  console.log("\n── Cost by Model ────────────────────────────");
  const modelEntries = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  for (const [model, data] of modelEntries) {
    const pct = ((data.cost / totalCost) * 100).toFixed(1);
    console.log(
      `  ${model.padEnd(30)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs`
    );
  }

  console.log("");
}

// --- Main ---
const since = parseSinceArg();
const entries = readEntries(since);
printReport(entries, since);
