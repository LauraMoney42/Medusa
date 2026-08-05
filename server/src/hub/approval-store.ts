import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

const ApprovalRequestSchema = z.object({
  id: z.string(),
  /** Bot session display name that raised the escalation */
  from: z.string(),
  /** What the bot needs approved (free text) */
  description: z.string(),
  /** Medusa session ID of the requesting bot, if known */
  sessionId: z.string(),
  /** Hub message ID this request was extracted from */
  hubMessageId: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Human-in-the-loop guardrail: bots escalate irreversible/uncertain actions via
 * `[HUB-POST: @You APPROVAL NEEDED: ...]`; this store persists those requests so
 * the user can Approve/Deny them from a dedicated UI instead of having to notice
 * and manually reply to a plain hub message.
 *
 * Same pattern as QuickTaskStore — atomic JSON writes, no database required.
 */
export class ApprovalStore {
  private requests: ApprovalRequest[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(raw)) throw new Error("approvals.json root is not an array");

      const loaded: ApprovalRequest[] = [];
      for (let i = 0; i < raw.length; i++) {
        const result = ApprovalRequestSchema.safeParse(raw[i]);
        if (result.success) {
          loaded.push(result.data);
        } else {
          console.error(`[approvals] ⚠️  Skipping invalid request at index ${i}:`);
          for (const issue of result.error.issues) {
            console.error(`  • path: [${issue.path.join(".")}] — ${issue.message}`);
          }
        }
      }

      this.requests = loaded;
    } catch (err) {
      console.error("[approvals] ⚠️  Could not parse approvals.json:", err);
      this.requests = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.requests, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[approvals] Failed to save:", err);
    }
  }

  getAll(): ApprovalRequest[] {
    // Newest first — the banner shows pending requests most-recent-on-top.
    return [...this.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getPending(): ApprovalRequest[] {
    return this.getAll().filter((r) => r.status === "pending");
  }

  create(data: { from: string; description: string; sessionId: string; hubMessageId: string }): ApprovalRequest {
    const now = new Date().toISOString();
    const req: ApprovalRequest = {
      id: randomUUID(),
      from: data.from,
      description: data.description,
      sessionId: data.sessionId,
      hubMessageId: data.hubMessageId,
      status: "pending",
      createdAt: now,
      resolvedAt: null,
    };
    this.requests.push(req);
    this.save();
    return req;
  }

  resolve(id: string, status: "approved" | "denied"): ApprovalRequest | undefined {
    const req = this.requests.find((r) => r.id === id);
    if (!req) return undefined;
    req.status = status;
    req.resolvedAt = new Date().toISOString();
    this.save();
    return req;
  }
}
