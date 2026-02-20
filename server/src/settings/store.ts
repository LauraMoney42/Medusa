import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { z } from "zod";
import config from "../config.js";

type AccountNumber = 1 | 2;

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
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: resolved, CLAUDECODE: "" },
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
 * Runs `claude login` which opens a browser for OAuth.
 */
export function loginAccount(configDir: string): Promise<{ success: boolean; error?: string }> {
  const resolved = resolveConfigDir(configDir);
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "login"],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: resolved, CLAUDECODE: "" },
        timeout: 120_000, // login may take a while (browser flow)
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

/**
 * Logs out of Claude CLI for a given config directory.
 * Runs `claude logout`.
 */
export function logoutAccount(configDir: string): Promise<{ success: boolean; error?: string }> {
  const resolved = resolveConfigDir(configDir);
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "logout"],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: resolved, CLAUDECODE: "" },
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
