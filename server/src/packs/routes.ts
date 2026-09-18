/**
 * HTTP surface for the Medusa layer and for packs.
 *
 * Two routers:
 *   /api/medusa/*  the live editors (persona, rules, theme, voice, toolbox)
 *   /api/packs/*   export, import, and the installed list
 *
 * Nothing here is engine specific. Everything it writes is picked up by
 * sessions/orchestrator-prompt.ts, which composes one prompt for every engine.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  PersonaSchema,
  ManifestSchema,
  ThemeSchema,
  ToolboxSchema,
  VoiceSchema,
  parsePack,
} from "./schema.js";
import {
  applyPack,
  deleteRule,
  exportPack,
  importPack,
  listInstalledPacks,
  listRules,
  loadEnabledRuleTexts,
  readInstalledPack,
  readPersona,
  readTheme,
  readToolbox,
  readVoice,
  removeInstalledPack,
  resetPersona,
  setRuleEnabled,
  writePersona,
  writeRule,
  writeTheme,
  writeToolbox,
  writeVoice,
} from "./store.js";
import { searchRegistry } from "./registry.js";
import { buildOrchestratorPrompt } from "../sessions/orchestrator-prompt.js";

/** Turn a zod failure into the flat `{ error, details }` the client shows. */
function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Invalid request body",
    details: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
  });
}

export function createMedusaRouter(): Router {
  const router = Router();

  // ---- Persona -----------------------------------------------------------

  router.get("/persona", (_req: Request, res: Response) => {
    res.json(readPersona());
  });

  router.put("/persona", (req: Request, res: Response) => {
    const parsed = PersonaSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.json(writePersona(parsed.data));
  });

  /** Drop ~/.medusa/MEDUSA.md so the bundled Medusa persona takes over. */
  router.post("/persona/reset", (_req: Request, res: Response) => {
    res.json(resetPersona());
  });

  /**
   * The composed system prompt, exactly as an engine would receive it. The
   * editor previews this so a persona change is visible before it is saved.
   */
  router.get("/preview", (req: Request, res: Response) => {
    const engineId = typeof req.query.engineId === "string" ? req.query.engineId : "claude";
    const workingDir =
      typeof req.query.workingDir === "string" && req.query.workingDir
        ? req.query.workingDir
        : "~/Projects/example";
    const personaText = typeof req.query.persona === "string" ? req.query.persona : undefined;
    res.json({
      engineId,
      prompt: buildOrchestratorPrompt({ engineId, workingDir, personaText }),
    });
  });

  // ---- Rules -------------------------------------------------------------

  router.get("/rules", (_req: Request, res: Response) => {
    res.json({ rules: listRules() });
  });

  const CreateRuleSchema = z.object({
    name: z.string().min(1).max(80),
    content: z.string().max(40_000).default(""),
    enabled: z.boolean().default(true),
  });

  router.post("/rules", (req: Request, res: Response) => {
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const name = parsed.data.name.endsWith(".md") ? parsed.data.name : `${parsed.data.name}.md`;
    const rule = writeRule(name, parsed.data.content, parsed.data.enabled);
    if (!rule) {
      return res
        .status(400)
        .json({ error: "Rule names may only contain letters, numbers, dot, dash and underscore." });
    }
    res.status(201).json(rule);
  });

  router.put("/rules/:name/enabled", (req: Request, res: Response) => {
    const enabled = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!enabled.success) return badRequest(res, enabled.error);
    const rule = setRuleEnabled(String(req.params.name), enabled.data.enabled);
    if (!rule) return res.status(404).json({ error: "No such rule" });
    res.json(rule);
  });

  router.delete("/rules/:name", (req: Request, res: Response) => {
    if (!deleteRule(String(req.params.name))) return res.status(404).json({ error: "No such rule" });
    res.json({ ok: true });
  });

  // ---- Theme, voice, toolbox ---------------------------------------------

  router.get("/theme", (_req: Request, res: Response) => {
    res.json(readTheme());
  });

  router.put("/theme", (req: Request, res: Response) => {
    const parsed = ThemeSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.json(writeTheme(parsed.data));
  });

  router.get("/voice", (_req: Request, res: Response) => {
    res.json(readVoice());
  });

  router.put("/voice", (req: Request, res: Response) => {
    const parsed = VoiceSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.json(writeVoice(parsed.data));
  });

  router.get("/toolbox", (_req: Request, res: Response) => {
    res.json(readToolbox());
  });

  router.put("/toolbox", (req: Request, res: Response) => {
    const parsed = ToolboxSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.json(writeToolbox(parsed.data));
  });

  /**
   * Candidates only. This proposes; it never installs. The client shows the
   * results in a modal and an entry joins the toolbox on an explicit Add.
   */
  router.get("/registry", (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ candidates: searchRegistry(q) });
  });

  /** Debug aid: the rule bodies the next turn will actually carry. */
  router.get("/rules/effective", (_req: Request, res: Response) => {
    res.json({ rules: loadEnabledRuleTexts() });
  });

  return router;
}

export function createPacksRouter(): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({ packs: listInstalledPacks() });
  });

  /** Snapshot the current setup. The body may name and describe the pack. */
  router.post("/export", (req: Request, res: Response) => {
    const parsed = ManifestSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    res.json(exportPack(parsed.data));
  });

  /** Validate a pack, back up the current set, then write it to ~/.medusa. */
  router.post("/import", (req: Request, res: Response) => {
    const result = importPack(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: "This is not a valid Medusa pack.", details: result.errors });
    }
    res.json({
      ok: true,
      manifest: result.pack.manifest,
      backup: result.backup,
      packs: listInstalledPacks(),
    });
  });

  /** Re-apply an already installed pack. */
  router.post("/:id/apply", (req: Request, res: Response) => {
    const pack = readInstalledPack(String(req.params.id));
    if (!pack) return res.status(404).json({ error: "No such pack" });
    const { backup } = applyPack(pack);
    res.json({ ok: true, manifest: pack.manifest, backup });
  });

  router.delete("/:id", (req: Request, res: Response) => {
    if (!removeInstalledPack(String(req.params.id))) return res.status(404).json({ error: "No such pack" });
    res.json({ ok: true, packs: listInstalledPacks() });
  });

  /** Validate without writing anything, so a drop can be checked first. */
  router.post("/validate", (req: Request, res: Response) => {
    const parsed = parsePack(req.body);
    if (!parsed.ok) return res.status(400).json({ error: "Invalid pack", details: parsed.errors });
    res.json({ ok: true, manifest: parsed.pack.manifest });
  });

  return router;
}
