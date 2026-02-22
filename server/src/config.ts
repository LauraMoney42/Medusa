import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, "../../.env");

// Auto-generate .env with a random AUTH_TOKEN on first run
if (!fs.existsSync(envPath)) {
  const token = crypto.randomBytes(32).toString("hex");
  const content = `# Medusa — auto-generated on first run\nHOST=0.0.0.0\nPORT=3456\nAUTH_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, content, "utf-8");
  console.log(`[medusa] Created .env with auto-generated AUTH_TOKEN`);
}

dotenv.config({ path: envPath });

export interface Config {
  host: string;
  port: number;
  authToken: string;
  allowedOrigins: string[];
  uploadsDir: string;
  sessionsFile: string;
  skillsCacheDir: string;
  hubFile: string;
  projectsFile: string;
  quickTasksFile: string;
  /** Path to persist interrupted session state for auto-resume on next startup */
  interruptedSessionsFile: string;
  /** Enable background Hub polling for idle bots (default: false) */
  hubPolling: boolean;
  /** Interval in ms between poll ticks (default: 120000 = 2 min) */
  hubPollIntervalMs: number;
  /** Time in ms before a pending task is considered stale and the bot gets nudged (default: 600000 = 10 min) */
  staleTaskThresholdMs: number;
  /** Max time in ms to wait for active sessions to finish during shutdown (default: 30000 = 30s) */
  gracefulTimeoutMs: number;
  /** Enable conversation summarization to compress old messages (default: true) */
  summarizationEnabled: boolean;
  /** Message count threshold for triggering summarization (default: 30) */
  summarizationThreshold: number;
  /** Enable tiered model routing (Haiku for simple, Sonnet for coding, Opus for architecture) (default: true) */
  modelRoutingEnabled: boolean;
  /** Enable hub context compression before injection (default: true) */
  compressionEnabled: boolean;
  /** Compression level: conservative | moderate | aggressive (default: moderate) */
  compressionLevel: "conservative" | "moderate" | "aggressive";
  /** Emit compression audit log to console (default: false) */
  compressionAudit: boolean;
  /** Path to compressor config file with exclusion patterns + safety limits (default: ~/.claude-chat/compressor.json) */
  compressorConfigFile: string;
  /** Path to token usage log file (JSONL format, default: ~/.claude-chat/token-usage.jsonl) */
  tokenUsageLogFile: string;
  /** Display name for account 1 */
  account1Name: string;
  /** CLAUDE_CONFIG_DIR path for account 1 (default: ~/.claude) */
  account1ConfigDir: string;
  /** Display name for account 2 */
  account2Name: string;
  /** CLAUDE_CONFIG_DIR path for account 2 (default: ~/.claude-account2) */
  account2ConfigDir: string;
}

const config: Config = {
  host: process.env.HOST || "0.0.0.0",
  port: parseInt(process.env.PORT || "3456", 10),
  authToken: process.env.AUTH_TOKEN || "",
  // P2-5: Default localhost origins are development-only. For any network-accessible
  // deployment, set ALLOWED_ORIGINS explicitly. The fallback is intentionally kept
  // to avoid breaking local dev workflows (this app is designed for localhost use).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173").split(","),
  uploadsDir: path.resolve(__dirname, "../uploads"),
  sessionsFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "sessions.json"
  ),
  skillsCacheDir: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat"
  ),
  hubFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "hub.json"
  ),
  projectsFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "projects.json"
  ),
  quickTasksFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "quick-tasks.json"
  ),
  interruptedSessionsFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "interrupted-sessions.json"
  ),
  hubPolling: process.env.HUB_POLLING === "true",
  hubPollIntervalMs: parseInt(process.env.HUB_POLL_INTERVAL_MS || "120000", 10),
  staleTaskThresholdMs: parseInt(process.env.STALE_TASK_THRESHOLD_MS || "600000", 10),
  gracefulTimeoutMs: parseInt(process.env.GRACEFUL_TIMEOUT_MS || "30000", 10),
  summarizationEnabled: process.env.SUMMARIZATION_ENABLED !== "false",
  summarizationThreshold: parseInt(process.env.SUMMARIZATION_THRESHOLD || "30", 10),
  modelRoutingEnabled: process.env.MODEL_ROUTING_ENABLED !== "false",
  compressionEnabled: process.env.COMPRESSION_ENABLED !== "false",
  compressionLevel: (process.env.COMPRESSION_LEVEL || "moderate") as "conservative" | "moderate" | "aggressive",
  compressionAudit: process.env.COMPRESSION_AUDIT === "true",
  compressorConfigFile: process.env.COMPRESSOR_CONFIG_FILE || path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "compressor.json"
  ),
  tokenUsageLogFile: process.env.TOKEN_USAGE_LOG_FILE || path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "token-usage.jsonl"
  ),
  account1Name: process.env.ACCOUNT_1_NAME || "Account 1",
  account1ConfigDir: process.env.ACCOUNT_1_CONFIG_DIR || "~/.claude",
  account2Name: process.env.ACCOUNT_2_NAME || "Account 2",
  account2ConfigDir: process.env.ACCOUNT_2_CONFIG_DIR || "~/.claude-account2",
};

export default config;
