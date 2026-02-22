#!/usr/bin/env node
/**
 * TC-6: CLI Token Compressor — standalone entry point.
 *
 * Two modes:
 *   1. Command wrapping:  compress <cmd> [args...]
 *      Spawns the command, captures stdout/stderr, compresses, outputs result.
 *   2. File/stdin input:  compress --input <file>  OR  echo "text" | compress
 *      Reads file or stdin, compresses, outputs result.
 *
 * Flags:
 *   --level <conservative|moderate|aggressive>  Compression level (default: moderate)
 *   --raw                                       Bypass compression — passthrough mode
 *   --audit                                     Show detailed removal report
 *   --input <file>                              Read from file instead of wrapping a command
 *   --help                                      Show usage
 *
 * Security guardrails (enforced):
 *   - Read-only: compresses output, never modifies source
 *   - No global hooks: invoked explicitly per-command, never auto-injected
 *   - No shell execution: spawns command directly (no shell interpretation)
 *   - No network calls: all processing strictly local
 *   - No filesystem scanning: reads only stdout/stderr of target command or --input file
 *   - Stateless: no persistent logging
 *   - Deterministic: same input + same flags = identical output
 *   - Transparency: compressed output shows ratio and what was removed
 */

import { spawn } from "child_process";
import fs from "fs";
import { compress, estimateTokens } from "./engine.js";
import type { CompressionLevel } from "./types.js";
import { loadCompressorConfig } from "./config.js";

// ---- Argument parsing (no deps — manual argv walk) --------------------------

interface CliArgs {
  level: CompressionLevel;
  raw: boolean;
  audit: boolean;
  inputFile: string | null;
  configFile: string | null;
  command: string[];
  help: boolean;
}

const VALID_LEVELS = new Set<string>(["conservative", "moderate", "aggressive"]);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    level: "moderate",
    raw: false,
    audit: false,
    inputFile: null,
    configFile: null,
    command: [],
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
    } else if (arg === "--raw") {
      args.raw = true;
      i++;
    } else if (arg === "--audit") {
      args.audit = true;
      i++;
    } else if (arg === "--level") {
      const next = argv[i + 1];
      if (!next || !VALID_LEVELS.has(next)) {
        process.stderr.write(
          `Error: --level must be one of: conservative, moderate, aggressive\n`
        );
        process.exit(1);
      }
      args.level = next as CompressionLevel;
      i += 2;
    } else if (arg === "--input") {
      const next = argv[i + 1];
      if (!next) {
        process.stderr.write(`Error: --input requires a file path\n`);
        process.exit(1);
      }
      args.inputFile = next;
      i += 2;
    } else if (arg === "--config") {
      const next = argv[i + 1];
      if (!next) {
        process.stderr.write(`Error: --config requires a file path\n`);
        process.exit(1);
      }
      args.configFile = next;
      i += 2;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Error: Unknown flag: ${arg}\n`);
      process.exit(1);
    } else {
      // Everything from here on is the command + its args
      args.command = argv.slice(i);
      break;
    }
  }

  return args;
}

// ---- Usage ------------------------------------------------------------------

function printUsage(): void {
  const usage = `
medusa-compress — CLI Token Compressor

USAGE:
  compress [flags] <command> [args...]     Wrap a command and compress its output
  compress [flags] --input <file>          Compress a file's contents
  echo "text" | compress [flags]           Compress stdin

FLAGS:
  --level <level>   Compression level: conservative, moderate, aggressive
                    (default: moderate, or from config file)
  --config <file>   Load config from file (default: ~/.claude-chat/compressor.json)
  --raw             Bypass compression — pass output through unchanged
  --audit           Show detailed report of what was removed
  --input <file>    Read from file instead of wrapping a command
  --help, -h        Show this help

EXAMPLES:
  compress cat server.log                  Compress a log file via cat
  compress --level aggressive git diff     Aggressively compress git diff output
  compress --raw claude --print "hello"    Pass through without compression
  compress --audit --input context.txt     Compress file with audit report
  echo "some text" | compress              Compress piped input

GUARDRAILS:
  • Read-only — compresses output, never modifies source
  • No global hooks — must be invoked explicitly per-command
  • No network calls — all processing is local
  • Stateless — no persistent logging
  • Deterministic — same input always produces same output
`.trim();

  process.stdout.write(usage + "\n");
}

// ---- Command execution (no shell — direct spawn) ----------------------------

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      // No shell — guardrail: wraps output only, does NOT interpret commands
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      process.stderr.write(`Error: Failed to spawn "${cmd}": ${err.message}\n`);
      process.exit(127);
    });

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
  });
}

// ---- Stdin reading ----------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // If stdin is a TTY (no piped input), return empty immediately
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

// ---- Output formatting ------------------------------------------------------

function formatAuditReport(
  audit: { compressed: string; removed: Array<{ strategy: string; reason: string; original: string }>; ratio: number },
  inputLen: number,
  outputLen: number,
  level: CompressionLevel
): string {
  const lines: string[] = [];
  lines.push("── Compression Audit ──");
  lines.push(`  Level: ${level}`);
  lines.push(`  Input:  ${inputLen} chars (~${estimateTokens(audit.compressed).toString()} tokens after compression)`);
  lines.push(`  Output: ${outputLen} chars`);
  lines.push(`  Ratio:  ${(audit.ratio * 100).toFixed(1)}% reduction`);
  lines.push("");

  if (audit.removed.length === 0) {
    lines.push("  No transformations applied.");
  } else {
    // Group by strategy
    const byStrategy = new Map<string, Array<{ reason: string; original: string }>>();
    for (const entry of audit.removed) {
      const list = byStrategy.get(entry.strategy) ?? [];
      list.push(entry);
      byStrategy.set(entry.strategy, list);
    }

    for (const [strategy, entries] of byStrategy) {
      lines.push(`  [${strategy}] — ${entries.length} transformation(s)`);
      // Group by reason within strategy
      const byReason = new Map<string, number>();
      for (const e of entries) {
        byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
      }
      for (const [reason, count] of byReason) {
        lines.push(`    • ${reason}: ${count}x`);
      }
    }
  }

  lines.push("───────────────────────");
  return lines.join("\n");
}

// ---- Main -------------------------------------------------------------------

// Parse argv: skip node binary path and script path
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

async function main(): Promise<void> {
  let input: string;

  if (args.inputFile) {
    // File mode: read from --input <file>
    if (!fs.existsSync(args.inputFile)) {
      process.stderr.write(`Error: File not found: ${args.inputFile}\n`);
      process.exit(1);
    }
    input = fs.readFileSync(args.inputFile, "utf-8");
  } else if (args.command.length > 0) {
    // Command mode: spawn command, capture output
    const [cmd, ...cmdArgs] = args.command;
    const result = await runCommand(cmd, cmdArgs);

    // Combine stdout and stderr (stderr first as context, then stdout as primary)
    input = result.stderr
      ? result.stderr.trimEnd() + "\n" + result.stdout
      : result.stdout;

    // Propagate the child's exit code if non-zero and --raw
    if (args.raw) {
      process.stdout.write(input);
      process.exit(result.exitCode);
    }
  } else {
    // Stdin mode: read from pipe
    input = await readStdin();
    if (!input) {
      process.stderr.write(
        "Error: No input. Provide a command, --input <file>, or pipe via stdin.\n" +
        "Run with --help for usage.\n"
      );
      process.exit(1);
    }
  }

  // --raw: passthrough mode, no compression
  if (args.raw) {
    process.stdout.write(input);
    process.exit(0);
  }

  // TC-2: Load config for exclusion patterns + safety limits
  const compressorConfig = loadCompressorConfig(args.configFile ?? undefined);

  // CLI --level flag overrides config file level
  const effectiveLevel = args.level !== "moderate" ? args.level : compressorConfig.level;

  // Compress with config-driven exclusion patterns and safety limits
  const result = compress(input, effectiveLevel, { audit: args.audit }, compressorConfig);

  // Output compressed text
  process.stdout.write(result.compressed);

  // If --audit, write report to stderr (so stdout stays clean for piping)
  if (args.audit && result.audit) {
    const report = formatAuditReport(
      result.audit,
      input.length,
      result.compressed.length,
      effectiveLevel
    );
    process.stderr.write("\n" + report + "\n");
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
