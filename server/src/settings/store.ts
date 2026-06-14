import fs from "fs";
import path from "path";
import os from "os";
import { execFile, execSync, spawn } from "child_process";
import { z } from "zod";
import config from "../config.js";

export type LlmProvider = "claude" | "kimi";

/**
 * Resolves ~ in config dir paths and returns the absolute CLAUDE_CONFIG_DIR.
 * Returns undefined when the config dir is the default (~/.claude), because
 * explicitly setting CLAUDE_CONFIG_DIR to the default value breaks auth
 * resolution in newer Claude CLI versions (2.1.170+).
 */
export function getActiveConfigDir(): string | undefined {
  const raw = config.claudeConfigDir;
  // Don't override the env var when using the default config dir
  if (raw === "~/.claude") return undefined;
  return raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
}

const SettingsSchema = z.object({
  activeProvider: z.enum(["claude", "kimi"]).nullable().default(null),
  // OneNote fields (not returned in buildSettingsResponse)
  microsoftClientId: z.string().default(""),
  microsoftAccessToken: z.string().default(""),
  microsoftRefreshToken: z.string().default(""),
  microsoftTokenExpiry: z.number().default(0),
});

type SettingsData = z.infer<typeof SettingsSchema>;

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
    console.error("[settings] Validation failed:", result.error.message);
    const fallback: Record<string, unknown> =
      parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return SettingsSchema.parse(fallback);
  } catch {
    return SettingsSchema.parse({});
  }
}

function save(data: SettingsData): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SETTINGS_FILE);
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (err) {
    console.error("[settings] Failed to save:", err);
  }
}

let state: SettingsData = load();

export function getActiveProvider(): LlmProvider | null {
  return state.activeProvider;
}

export function setActiveProvider(provider: LlmProvider | null): void {
  state = { ...state, activeProvider: provider };
  save(state);
  console.log(`[settings] Provider set to ${provider}`);
}

export function getSettings(): SettingsData {
  return state;
}

export function buildSettingsResponse(): { activeProvider: LlmProvider | null } {
  return { activeProvider: state.activeProvider };
}

// ---- OneNote token helpers (preserved) --------------------------------------

export function updateOneNoteTokens(
  accessToken: string,
  refreshToken: string,
  expiry: number,
  clientId?: string
): void {
  const patch: Partial<SettingsData> = {};
  // These fields are preserved in the file even though they're not in the schema
  // We merge them manually to avoid schema violations
  const raw = loadRaw();
  raw.microsoftAccessToken = accessToken;
  raw.microsoftRefreshToken = refreshToken;
  raw.microsoftTokenExpiry = expiry;
  if (clientId !== undefined) raw.microsoftClientId = clientId;
  saveRaw(raw);
}

export function clearOneNoteTokens(): void {
  const raw = loadRaw();
  raw.microsoftAccessToken = "";
  raw.microsoftRefreshToken = "";
  raw.microsoftTokenExpiry = 0;
  saveRaw(raw);
}

function loadRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveRaw(data: Record<string, unknown>): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SETTINGS_FILE);
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (err) {
    console.error("[settings] Failed to save raw:", err);
  }
}

// ---- Binary discovery ----

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

function findKimiBinary(): string {
  const candidates = [
    (() => { try { return execSync("which kimi", { encoding: "utf-8" }).trim(); } catch { return null; } })(),
    "/usr/local/bin/kimi",
    "/opt/homebrew/bin/kimi",
    `${process.env.HOME}/.local/bin/kimi`,
    `${process.env.HOME}/.npm-global/bin/kimi`,
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* continue */ }
  }
  return "kimi";
}

const CLAUDE_BIN = findClaudeBinary();
const KIMI_BIN = findKimiBinary();

// ---- Browser helper ----

function openBrowser(url: string): void {
  try {
    fs.accessSync("/Applications/Google Chrome.app", fs.constants.F_OK);
    spawn("open", ["-a", "Google Chrome", url], { stdio: "ignore", detached: true }).unref();
  } catch {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

// ---- Login / Logout ----

export function loginClaude(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["auth", "login"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
    });

    let stdout = "";
    let stderr = "";
    let urlOpened = false;

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!urlOpened) {
        const match = text.match(/(https:\/\/claude\.ai\/oauth\/authorize[^\s]+)/);
        if (match) {
          urlOpened = true;
          openBrowser(match[1]);
        }
      }
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      handleOutput(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: "Login timed out" });
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { success: true } : { success: false, error: stderr || `Exit code ${code}` });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

export function logoutClaude(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ["auth", "logout"], { timeout: 10_000 }, (err, _stdout, stderr) => {
      resolve(err ? { success: false, error: stderr || err.message } : { success: true });
    });
  });
}

export function loginKimi(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(KIMI_BIN, ["login", "--json"], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let urlOpened = false;

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!urlOpened) {
        for (const line of text.split("\n")) {
          try {
            const obj = JSON.parse(line.trim());
            if (obj.type === "verification_url" && obj.data?.verification_url) {
              urlOpened = true;
              openBrowser(obj.data.verification_url);
            }
          } catch { /* ignore */ }
        }
      }
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      handleOutput(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: "Login timed out" });
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { success: true } : { success: false, error: stderr || `Exit code ${code}` });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

export function logoutKimi(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(KIMI_BIN, ["logout"], { timeout: 10_000 }, (err, _stdout, stderr) => {
      resolve(err ? { success: false, error: stderr || err.message } : { success: true });
    });
  });
}
