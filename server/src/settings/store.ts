import fs from "fs";
import path from "path";
import os from "os";
import { execFile, execSync, spawn } from "child_process";
import { z } from "zod";
import config from "../config.js";

type AccountNumber = 1 | 2;

/**
 * Resolve the absolute path to the `claude` CLI binary.
 * The macOS app doesn't include ~/.local/bin in PATH, so we must resolve it.
 */
function findClaudeBinary(): string {
  const candidates = [
    (() => { try { return execSync("which claude", { encoding: "utf-8" }).trim(); } catch { return null; } })(),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* continue */ }
  }
  return "claude";
}

const CLAUDE_BIN = findClaudeBinary();

export type LlmProvider = "claude" | "openai";

const SettingsSchema = z.object({
  activeAccount: z.union([z.literal(1), z.literal(2)]).default(1),
  llmProvider: z.enum(["claude", "openai"]).default("claude"),
  // Stored as plaintext — file is chmod 600, never returned in full via API
  llmApiKey: z.string().default(""),
});

type SettingsData = z.infer<typeof SettingsSchema>;

// Public shape returned to API callers — token is always masked
export interface SettingsResponse {
  activeAccount: AccountNumber;
  llmProvider: LlmProvider;
  /** Masked API key — shows only last 4 chars (e.g. "sk-...abcd"). Empty string if not set. */
  llmApiKey: string;
  accounts: Array<{ id: number; name: string; configDir: string }>;
}

const SETTINGS_FILE = path.join(
  process.env.HOME || os.homedir(),
  ".claude-chat",
  "settings.json"
);

function load(): SettingsData {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = SettingsSchema.safeParse(parsed);
    if (result.success) return result.data;
    // Validation failed — log and fall back to defaults, preserving activeAccount if readable
    console.error("[settings] Settings file validation failed:", result.error.message);
    const fallback =
      parsed !== null && typeof parsed === "object" && "activeAccount" in parsed
        ? (parsed as Record<string, unknown>).activeAccount
        : undefined;
    return SettingsSchema.parse({ activeAccount: fallback });
  } catch {
    return SettingsSchema.parse({});
  }
}

function save(data: SettingsData): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to .tmp then rename to avoid partial reads
    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SETTINGS_FILE);
    // Restrict to owner read/write only — file contains API keys
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (err) {
    console.error("[settings] Failed to save settings:", err);
  }
}

let state: SettingsData = load();

// ---- Masking ----------------------------------------------------------------

/**
 * Returns a masked version of an API key suitable for API responses.
 * Shows only the last 4 characters: "sk-...abcd". Returns empty string if key is unset.
 * The full key is never sent to clients.
 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return `sk-...${key.slice(-4)}`;
}

// ---- Accessors (existing — preserved for backward compat) -------------------

export function getActiveAccount(): AccountNumber {
  return state.activeAccount;
}

export function setActiveAccount(account: AccountNumber): void {
  state = { ...state, activeAccount: account };
  save(state);
  console.log(`[settings] Switched to account ${account}`);
}

/** Resolves ~ in config dir paths and returns the absolute CLAUDE_CONFIG_DIR. */
export function getActiveConfigDir(): string {
  const raw =
    state.activeAccount === 1
      ? config.account1ConfigDir
      : config.account2ConfigDir;
  return raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
}

// ---- New settings accessors -------------------------------------------------

export function getSettings(): SettingsData {
  return state;
}

/**
 * Applies a partial update to settings, validates the merged result, and persists.
 * Returns the full settings (raw, including unmasked key — callers must mask before sending to API).
 */
export function updateSettings(
  patch: Partial<Pick<SettingsData, "llmProvider" | "llmApiKey">>
): SettingsData {
  const merged = { ...state, ...patch };
  // Re-parse the merged object so Zod coerces and validates — rejects bad values early
  state = SettingsSchema.parse(merged);
  save(state);
  return state;
}

/** Builds the public API response shape (token masked). */
export function buildSettingsResponse(): SettingsResponse {
  return {
    activeAccount: state.activeAccount,
    llmProvider: state.llmProvider,
    llmApiKey: maskApiKey(state.llmApiKey),
    accounts: [
      { id: 1, name: config.account1Name, configDir: config.account1ConfigDir },
      { id: 2, name: config.account2Name, configDir: config.account2ConfigDir },
    ],
  };
}

// ---- Login status -----------------------------------------------------------

export interface AccountLoginStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

/** Resolves ~ to homedir for a config dir path. */
function resolveConfigDir(raw: string): string {
  return raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
}

/**
 * Checks whether the Claude CLI is logged in for a given config directory.
 * Runs `claude auth status --json` with CLAUDE_CONFIG_DIR set and CLAUDECODE unset
 * so it doesn't pick up the parent process's auth.
 */
export function checkAccountLoginStatus(configDir: string): Promise<AccountLoginStatus> {
  const resolved = resolveConfigDir(configDir);
  // Build env without CLAUDECODE — setting it to "" is different from unsetting it.
  // Spreading process.env then deleting ensures the child process doesn't inherit it.
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: resolved };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ["auth", "status", "--json"],
      {
        env: childEnv as NodeJS.ProcessEnv,
        timeout: 10_000,
      },
      (err, stdout, stderr) => {
        // claude auth status exits with code 1 when not logged in, but still
        // outputs valid JSON on stdout. Parse stdout regardless of exit code.
        const output = (stdout || "").trim() || (stderr || "").trim();
        if (!output) {
          resolve({ loggedIn: false });
          return;
        }
        try {
          const data = JSON.parse(output);
          if (data.loggedIn || data.authenticated) {
            resolve({
              loggedIn: true,
              email: data.account_email || data.email,
              subscriptionType: data.subscription_type || data.subscriptionType,
            });
          } else {
            resolve({ loggedIn: false });
          }
        } catch {
          resolve({ loggedIn: false });
        }
      }
    );
  });
}

/** Checks login status for both accounts in parallel. */
export async function checkAllAccountsLoginStatus(): Promise<Record<number, AccountLoginStatus>> {
  const [status1, status2] = await Promise.all([
    checkAccountLoginStatus(config.account1ConfigDir),
    checkAccountLoginStatus(config.account2ConfigDir),
  ]);
  return { 1: status1, 2: status2 };
}

/**
 * Logs in to Claude CLI for a given config directory.
 * Spawns `claude auth login`, captures the OAuth URL from stdout,
 * and opens it with macOS `open` since the server process can't
 * open a browser directly from execFile.
 */
export function loginAccount(configDir: string): Promise<{ success: boolean; error?: string }> {
  const resolved = resolveConfigDir(configDir);
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: resolved };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["auth", "login"], {
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let urlOpened = false;

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Look for the OAuth URL in the output and open it with macOS `open`
      if (!urlOpened) {
        const urlMatch = text.match(/(https:\/\/claude\.ai\/oauth\/authorize[^\s]+)/);
        if (urlMatch) {
          urlOpened = true;
          console.log(`[settings] Opening OAuth URL for ${configDir}`);
          spawn("open", [urlMatch[1]], { stdio: "ignore", detached: true }).unref();
        }
      }
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      handleOutput(chunk);
    });

    // Timeout after 2 minutes
    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: "Login timed out" });
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr || `Exit code ${code}` });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Logs out of Claude CLI for a given config directory.
 * Runs `claude logout`.
 */
export function logoutAccount(configDir: string): Promise<{ success: boolean; error?: string }> {
  const resolved = resolveConfigDir(configDir);
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: resolved };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ["auth", "logout"],
      {
        env: childEnv as NodeJS.ProcessEnv,
        timeout: 10_000,
      },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: stderr || err.message });
        } else {
          resolve({ success: true });
        }
      }
    );
  });
}

/** Returns the config dir for a given account number. */
export function getConfigDirForAccount(account: AccountNumber): string {
  return account === 1 ? config.account1ConfigDir : config.account2ConfigDir;
}
