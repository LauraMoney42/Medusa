import fs from "fs";
import path from "path";

const GITHUB_TREE_URL =
  "https://api.github.com/repos/ComposioHQ/awesome-claude-skills/git/trees/master";
const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master";

const EXCLUDED_DIRS = new Set([".claude-plugin", "template-skill", ".github"]);

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
}

/**
 * Fetches, caches, and serves skill metadata and content
 * from the ComposioHQ/awesome-claude-skills GitHub repository.
 */
export class SkillCatalog {
  private cacheDir: string;
  private catalogFile: string;
  private catalog: SkillInfo[] = [];
  private ready = false;

  constructor(baseDir: string) {
    this.cacheDir = path.join(baseDir, "skills-cache");
    this.catalogFile = path.join(baseDir, "skills-catalog.json");
  }

  /** Returns the current catalog (may be incomplete if background fetch is running). */
  getCatalog(): { skills: SkillInfo[]; ready: boolean } {
    return { skills: this.catalog, ready: this.ready };
  }

  /** Load from disk cache if fresh, otherwise kick off background refresh. */
  async initialize(): Promise<void> {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // Try loading from disk cache
    if (fs.existsSync(this.catalogFile)) {
      try {
        const stat = fs.statSync(this.catalogFile);
        const ageMs = Date.now() - stat.mtimeMs;
        const raw = fs.readFileSync(this.catalogFile, "utf-8");
        this.catalog = JSON.parse(raw);

        if (ageMs < 24 * 60 * 60 * 1000) {
          this.ready = true;
          console.log(
            `[skills] Loaded ${this.catalog.length} skills from disk cache`
          );
          return;
        }
        // Cache is stale but usable — serve it while refreshing
        this.ready = true;
      } catch {
        // Corrupted cache — will re-fetch
      }
    }

    this.refreshInBackground();
  }

  private async refreshInBackground(): Promise<void> {
    try {
      console.log("[skills] Starting background catalog refresh...");

      // Fetch the tree listing to get all directory names
      const res = await fetch(GITHUB_TREE_URL);
      if (!res.ok) throw new Error(`GitHub tree API ${res.status}`);

      const data = (await res.json()) as {
        tree: Array<{ type: string; path: string }>;
      };

      const dirs = data.tree
        .filter(
          (t) =>
            t.type === "tree" &&
            !EXCLUDED_DIRS.has(t.path) &&
            !t.path.startsWith(".")
        )
        .map((t) => t.path);

      // Batch-fetch SKILL.md frontmatter
      const BATCH_SIZE = 50;
      const skills: SkillInfo[] = [];

      for (let i = 0; i < dirs.length; i += BATCH_SIZE) {
        const batch = dirs.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((slug) => this.fetchSkillFrontmatter(slug))
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) {
            skills.push(r.value);
          }
        }
      }

      skills.sort((a, b) => a.name.localeCompare(b.name));
      this.catalog = skills;
      this.ready = true;

      // Persist to disk
      const dir = path.dirname(this.catalogFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.catalogFile,
        JSON.stringify(skills, null, 2),
        "utf-8"
      );
      console.log(`[skills] Catalog refreshed: ${skills.length} skills`);
    } catch (err) {
      console.error("[skills] Background refresh failed:", err);
      if (this.catalog.length > 0) {
        this.ready = true;
      }
    }
  }

  /** Fetch a SKILL.md and parse just the YAML frontmatter. */
  private async fetchSkillFrontmatter(
    slug: string
  ): Promise<SkillInfo | null> {
    const url = `${GITHUB_RAW_BASE}/${slug}/SKILL.md`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();

      // Also cache the full content while we have it
      const cached = path.join(this.cacheDir, `${slug}.md`);
      fs.writeFileSync(cached, text, "utf-8");

      return this.parseFrontmatter(slug, text);
    } catch {
      return null;
    }
  }

  /** Extract name and description from YAML frontmatter. */
  private parseFrontmatter(slug: string, content: string): SkillInfo {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let name = this.prettifySlug(slug);
    let description = "";

    if (fmMatch) {
      const yaml = fmMatch[1];
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    return { slug, name, description };
  }

  /** "slack-automation" → "Slack Automation" */
  private prettifySlug(slug: string): string {
    return slug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  /** Fetch full SKILL.md content for a slug, using disk cache. */
  async getSkillContent(slug: string): Promise<string | null> {
    const cached = path.join(this.cacheDir, `${slug}.md`);

    // Check disk cache (24h TTL)
    if (fs.existsSync(cached)) {
      const stat = fs.statSync(cached);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        return fs.readFileSync(cached, "utf-8");
      }
    }

    // Fetch from GitHub
    const url = `${GITHUB_RAW_BASE}/${slug}/SKILL.md`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      fs.writeFileSync(cached, text, "utf-8");
      return text;
    } catch {
      // Fall back to stale cache if available
      if (fs.existsSync(cached)) {
        return fs.readFileSync(cached, "utf-8");
      }
      return null;
    }
  }

  /** Build the combined system prompt string from an array of skill slugs. */
  async buildSkillsPrompt(slugs: string[]): Promise<string> {
    if (!slugs || slugs.length === 0) return "";

    const contents: string[] = [];
    for (const slug of slugs) {
      const content = await this.getSkillContent(slug);
      if (content) {
        contents.push(content);
      }
    }

    if (contents.length === 0) return "";
    return "\n\n--- SKILLS ---\n\n" + contents.join("\n\n---\n\n");
  }
}
