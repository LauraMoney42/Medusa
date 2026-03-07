/**
 * TicTalk Proxy Endpoint
 *
 * Provides a secure server-side proxy between TicBuddy/TicTamer iOS apps
 * and the Anthropic Claude API. This keeps the API key off the device and
 * adds rate limiting + auth so the endpoint can't be abused.
 *
 * POST /api/tictalk
 *   Body: { messages: ChatMessage[], systemPrompt: string }
 *   Returns: { response: string }
 *   Auth: Bearer token matching AUTH_TOKEN env var
 *   Rate limit: 20 req/min per IP
 */

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import config from "../config.js";

// ---- Types ----

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface TicTalkRequestBody {
  messages: ChatMessage[];
  systemPrompt: string;
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text: string }>;
  error?: { message: string };
}

// ---- Rate limiter: 20 requests per minute per IP ----
// Stricter than generalLimiter (500/15 min) because each call hits the
// paid Anthropic API — prevents runaway loops or abuse.
const ticTalkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded — max 20 requests per minute" },
});

// ---- Route factory ----

export function createTicTalkRouter(): Router {
  const router = Router();

  router.post("/", ticTalkLimiter, async (req: Request, res: Response) => {
    // ---- Auth: validate shared secret from Authorization header ----
    // The global authMiddleware also enforces this, but we check explicitly
    // here as defense-in-depth since this route proxies to a paid API.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token || token !== config.authToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // ---- Input validation ----
    const { messages, systemPrompt } = req.body as Partial<TicTalkRequestBody>;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages must be a non-empty array" });
      return;
    }

    // Validate each message has valid role + content
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") {
        res.status(400).json({ error: "Each message must be an object" });
        return;
      }
      if (msg.role !== "user" && msg.role !== "assistant") {
        res.status(400).json({ error: 'Each message role must be "user" or "assistant"' });
        return;
      }
      if (typeof msg.content !== "string" || !msg.content.trim()) {
        res.status(400).json({ error: "Each message must have non-empty string content" });
        return;
      }
    }

    if (!systemPrompt || typeof systemPrompt !== "string" || !systemPrompt.trim()) {
      res.status(400).json({ error: "systemPrompt is required" });
      return;
    }

    // Guard against oversized payloads (defense-in-depth alongside express body limit)
    const MAX_MESSAGES = 50;
    if (messages.length > MAX_MESSAGES) {
      res.status(400).json({ error: `messages array exceeds maximum length of ${MAX_MESSAGES}` });
      return;
    }

    // ---- Inject API key from env ----
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[tictalk] ANTHROPIC_API_KEY is not set in environment");
      res.status(500).json({ error: "Server configuration error" });
      return;
    }

    // ---- Forward to Anthropic Claude API ----
    try {
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 1024,
          system: systemPrompt.trim(),
          // Sanitize: strip leading/trailing whitespace from all message content
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content.trim(),
          })),
        }),
      });

      // ---- Handle Anthropic API errors ----
      if (!anthropicRes.ok) {
        const errorText = await anthropicRes.text();
        console.error(`[tictalk] Anthropic API responded ${anthropicRes.status}: ${errorText}`);
        res.status(500).json({ error: "Claude API error" });
        return;
      }

      const data = (await anthropicRes.json()) as AnthropicMessagesResponse;

      // Extract text blocks from the response content array
      const responseText = data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      res.json({ response: responseText });
    } catch (err) {
      console.error("[tictalk] Unexpected error forwarding to Anthropic:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
