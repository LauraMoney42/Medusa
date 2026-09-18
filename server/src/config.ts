import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Single-file bundlers (pkg, some bun modes) leave import.meta.url undefined;
// fall back to cwd so the MEDUSA_* overrides below can still take effect.
const __dirname = import.meta.url
  ? path.dirname(fileURLToPath(import.meta.url))
  : process.cwd();

// Path-resolution overrides, needed by hosts (e.g. the Tauri sidecar) that
// run this server from a compiled/bundled location where import.meta.url no
// longer points at a real path inside the repo. Unset by default: every
// value falls back to the pre-existing __dirname-relative resolution.
//
// - MEDUSA_ENV_FILE: full path to the .env file (default: repo root, two
//   levels up from server/dist).
// - MEDUSA_DATA_DIR: directory that holds uploads/ and default-bots.json
//   (default: server root, one level up from server/dist).
// - MEDUSA_STATIC_DIR: directory the built client is served from (default:
//   server/dist/public).
const envPath = process.env.MEDUSA_ENV_FILE
  ? path.resolve(process.env.MEDUSA_ENV_FILE)
  : path.resolve(__dirname, "../../.env");

const dataDir = process.env.MEDUSA_DATA_DIR
  ? path.resolve(process.env.MEDUSA_DATA_DIR)
  : path.resolve(__dirname, "..");

const staticDir = process.env.MEDUSA_STATIC_DIR
  ? path.resolve(process.env.MEDUSA_STATIC_DIR)
  : path.resolve(__dirname, "public");

// Auto-generate .env with a random AUTH_TOKEN on first run
if (!fs.existsSync(envPath)) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const content = `# Medusa - auto-generated on first run\nHOST=0.0.0.0\nPORT=3456\nAUTH_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, content, "utf-8");
  console.log(`[medusa] Created .env with auto-generated AUTH_TOKEN`);
}

dotenv.config({ path: envPath });

export interface Config {
  host: string;
  port: number;
  authToken: string;
  /** True when this server was spawned as the desktop shell's sidecar (env: MEDUSA_DESKTOP). No behavior change today: reserved so future features can branch on desktop vs. browser. */
  isDesktop: boolean;
  allowedOrigins: string[];
  /** Directory holding uploads/ and default-bots.json (override: MEDUSA_DATA_DIR) */
  dataDir: string;
  /** Directory the built client is served from (override: MEDUSA_STATIC_DIR) */
  staticDir: string;
  uploadsDir: string;
  sessionsFile: string;
  skillsCacheDir: string;
  projectsFile: string;
  quickTasksFile: string;
  /** Path to persist interrupted session state for auto-resume on next startup */
  interruptedSessionsFile: string;
  /** Max time in ms to wait for active sessions to finish during shutdown (default: 30000 = 30s) */
  gracefulTimeoutMs: number;
  /** Max subagents running at once across every chat (default: 6) */
  maxSubagentsTotal: number;
  /** Max subagents running at once for one chat (default: 3) */
  maxSubagentsPerSession: number;
  /** Directory holding per-subagent JSONL transcripts */
  subagentsDir: string;
  /** Enable conversation summarization to compress old messages (default: true) */
  summarizationEnabled: boolean;
  /** Message count threshold for triggering summarization (default: 30) */
  summarizationThreshold: number;
  /** Enable tiered model routing (Haiku for simple, Sonnet for coding, Opus for architecture) (default: true) */
  modelRoutingEnabled: boolean;
  /** Enable system-prompt compression before injection (default: true) */
  compressionEnabled: boolean;
  /** Compression level: conservative | moderate | aggressive (default: moderate) */
  compressionLevel: "conservative" | "moderate" | "aggressive";
  /** Emit compression audit log to console (default: false) */
  compressionAudit: boolean;
  /** Path to compressor config file with exclusion patterns + safety limits (default: ~/.claude-chat/compressor.json) */
  compressorConfigFile: string;
  /** Path to token usage log file (JSONL format, default: ~/.claude-chat/token-usage.jsonl) */
  tokenUsageLogFile: string;
  /** CLAUDE_CONFIG_DIR path (default: ~/.claude) */
  claudeConfigDir: string;
  /** KIMI_CONFIG_DIR path (default: ~/.kimi) */
  kimiConfigDir: string;
  /** Route bot `claude` traffic through the Headroom compression proxy (default: true) */
  headroomEnabled: boolean;
  /** Local port for the Headroom proxy (default: 8787) */
  headroomPort: number;
  /** Enable the speech-to-text (mic) endpoint (default: true) */
  sttEnabled: boolean;
  /** OpenAI-compatible base URL for audio transcription (default: OpenAI) */
  sttApiBaseUrl: string;
  /** API key for the transcription endpoint (empty = mic button stays hidden) */
  sttApiKey: string;
  /** Transcription model name (default: whisper-1) */
  sttModel: string;
  /** Auto-start a local Whisper STT server when Medusa boots (default: true) */
  sttAutostart: boolean;
  /** Path to the local STT server run script */
  sttRunScript: string;
  /** Enable the text-to-speech (voice-out) endpoint (default: true) */
  ttsEnabled: boolean;
  /** OpenAI-compatible base URL for speech synthesis (default: local Kokoro) */
  ttsApiBaseUrl: string;
  /** API key for the TTS endpoint (empty allowed for a local server) */
  ttsApiKey: string;
  /** TTS model name (default: kokoro) */
  ttsModel: string;
  /** Default TTS voice (default: af_heart) */
  ttsVoice: string;
  /** Auto-start a local TTS server when Medusa boots (default: true) */
  ttsAutostart: boolean;
  /** Path to the local TTS server run script */
  ttsRunScript: string;
}

const config: Config = {
  host: process.env.HOST || "0.0.0.0",
  port: parseInt(process.env.PORT || "3456", 10),
  authToken: process.env.AUTH_TOKEN || "",
  isDesktop: process.env.MEDUSA_DESKTOP === "1",
  // P2-5: Default localhost origins are development-only. For any network-accessible
  // deployment, set ALLOWED_ORIGINS explicitly. The fallback is intentionally kept
  // to avoid breaking local dev workflows (this app is designed for localhost use).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173").split(","),
  dataDir,
  staticDir,
  uploadsDir: path.join(dataDir, "uploads"),
  sessionsFile: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "sessions.json"
  ),
  skillsCacheDir: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat"
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
  gracefulTimeoutMs: parseInt(process.env.GRACEFUL_TIMEOUT_MS || "30000", 10),
  maxSubagentsTotal: parseInt(process.env.MEDUSA_MAX_SUBAGENTS_TOTAL || "6", 10),
  maxSubagentsPerSession: parseInt(
    process.env.MEDUSA_MAX_SUBAGENTS_PER_SESSION || "3",
    10
  ),
  subagentsDir: path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "subagents"
  ),
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
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || "~/.claude",
  kimiConfigDir: process.env.KIMI_CONFIG_DIR || "~/.kimi",
  headroomEnabled: process.env.HEADROOM_ENABLED !== "false",
  headroomPort: parseInt(process.env.HEADROOM_PORT || "8787", 10),
  sttEnabled: process.env.STT_ENABLED !== "false",
  sttApiBaseUrl: process.env.STT_API_BASE_URL || "https://api.openai.com/v1",
  sttApiKey: process.env.STT_API_KEY || "",
  sttModel: process.env.STT_MODEL || "whisper-1",
  sttAutostart: process.env.STT_AUTOSTART !== "false",
  sttRunScript: process.env.STT_RUN_SCRIPT || path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".medusa-stt",
    "run.sh"
  ),
  ttsEnabled: process.env.TTS_ENABLED !== "false",
  ttsApiBaseUrl: process.env.TTS_API_BASE_URL || "http://localhost:8001/v1",
  ttsApiKey: process.env.TTS_API_KEY || "local",
  ttsModel: process.env.TTS_MODEL || "kokoro",
  ttsVoice: process.env.TTS_VOICE || "af_heart",
  ttsAutostart: process.env.TTS_AUTOSTART !== "false",
  ttsRunScript: process.env.TTS_RUN_SCRIPT || path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".medusa-tts",
    "run.sh"
  ),
};

export default config;
