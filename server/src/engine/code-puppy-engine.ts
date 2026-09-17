import fs from "fs";
import os from "os";
import path from "path";
import { AcpEngine } from "./acp-engine.js";
import type { ModelInfo } from "./types.js";

/**
 * Code Puppy's config lives at `$XDG_CONFIG_HOME/code_puppy/puppy.cfg`
 * (default `~/.config/code_puppy/puppy.cfg`), an ini-style file.
 */
export function puppyConfigPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "code_puppy", "puppy.cfg");
}

/**
 * Code Puppy's `ensure_config_exists()` requires `puppy_name` and `owner_name`
 * and falls back to Python's blocking `input()` when either is missing, even
 * in headless modes. A background spawn has no stdin to answer with, so the
 * process would hang forever on its first run. Writing a minimal config ahead
 * of the first spawn is the only documented way to avoid the wizard.
 *
 * This never overwrites an existing config: if the user has already configured
 * Code Puppy, their settings win.
 */
export function ensurePuppyConfig(configPath = puppyConfigPath()): boolean {
  if (fs.existsSync(configPath)) return false;

  const model = process.env.CODE_PUPPY_MODEL ?? "gpt-5";
  const lines = [
    "[puppy]",
    `puppy_name = ${process.env.CODE_PUPPY_NAME ?? "Medusa Puppy"}`,
    `owner_name = ${process.env.CODE_PUPPY_OWNER ?? "Medusa"}`,
    `model = ${model}`,
  ];
  // The provider is only meaningful for custom/local endpoints; skip it
  // otherwise so Code Puppy's own model_factory resolution stays in charge.
  if (process.env.CODE_PUPPY_PROVIDER) {
    lines.push(`provider = ${process.env.CODE_PUPPY_PROVIDER}`);
  }
  lines.push("yolo_mode = true", "");

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, lines.join("\n"), "utf-8");
    console.log(`[code-puppy] Seeded minimal config at ${configPath}`);
    return true;
  } catch (err) {
    console.warn(`[code-puppy] Could not seed ${configPath}:`, err);
    return false;
  }
}

/**
 * Models Code Puppy can be pointed at, per the spike in
 * docs/code_puppy_stream_format.md. ACP exposes no model-listing method and
 * Code Puppy's own `models.json` ships empty, so this is a static list of the
 * provider types `code_puppy/model_factory.py` knows how to build.
 *
 * Note: ACP's `session/new` takes no model parameter, so the per-message model
 * picker cannot switch Code Puppy's model mid-session; the entry chosen here
 * is written to puppy.cfg on first seed and applies process-wide.
 */
export const CODE_PUPPY_MODELS: ModelInfo[] = [
  { id: "gpt-5", label: "GPT-5 (OpenAI)" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Anthropic)" },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1 (Anthropic)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "cerebras-qwen-3-coder", label: "Qwen 3 Coder (Cerebras)" },
  { id: "zai-glm-4.6", label: "GLM 4.6 (Z.ai)" },
  { id: "openrouter", label: "OpenRouter (model from puppy.cfg)" },
  { id: "claude_code", label: "Claude Code (local CLI shell-out)" },
];

/** `code-puppy --acp`, driven through the generic ACP engine. */
export function createCodePuppyEngine(): AcpEngine {
  return new AcpEngine({
    id: "code-puppy",
    displayName: "Code Puppy",
    command: "code-puppy",
    args: ["--acp"],
    models: CODE_PUPPY_MODELS,
    prepare: () => {
      ensurePuppyConfig();
    },
  });
}
