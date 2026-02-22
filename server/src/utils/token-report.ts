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
  const byBot: Record<string, { cost: number; count: number; duration: number }> = {};
  const bySource: Record<string, { cost: number; count: number }> = {};

  for (const e of entries) {
    totalCost += e.costUsd;
    totalDuration += e.durationMs;
    if (e.success) successCount++;

    if (!byBot[e.botName]) byBot[e.botName] = { cost: 0, count: 0, duration: 0 };
    byBot[e.botName].cost += e.costUsd;
    byBot[e.botName].count += 1;
    byBot[e.botName].duration += e.durationMs;

    if (!bySource[e.source]) bySource[e.source] = { cost: 0, count: 0 };
    bySource[e.source].cost += e.costUsd;
    bySource[e.source].count += 1;
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
  console.log(`Total time:    ${formatDuration(totalDuration)}`);
  console.log(`Avg time/msg:  ${formatDuration(totalDuration / entries.length)}`);
  console.log(`Msgs/hour:     ${(entries.length / timeSpanHours).toFixed(1)}`);

  // Cost by bot
  console.log("\n── Cost by Bot ──────────────────────────────");
  const botEntries = Object.entries(byBot).sort((a, b) => b[1].cost - a[1].cost);
  for (const [bot, data] of botEntries) {
    const pct = ((data.cost / totalCost) * 100).toFixed(1);
    console.log(
      `  ${bot.padEnd(20)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs  avg ${formatDuration(data.duration / data.count)}`
    );
  }

  // Cost by source
  console.log("\n── Cost by Source ───────────────────────────");
  const sourceEntries = Object.entries(bySource).sort((a, b) => b[1].cost - a[1].cost);
  for (const [source, data] of sourceEntries) {
    const pct = ((data.cost / totalCost) * 100).toFixed(1);
    console.log(
      `  ${source.padEnd(20)} ${formatCost(data.cost).padStart(10)}  (${pct}%)  ${data.count} msgs`
    );
  }

  console.log("");
}

// --- Main ---
const since = parseSinceArg();
const entries = readEntries(since);
printReport(entries, since);
