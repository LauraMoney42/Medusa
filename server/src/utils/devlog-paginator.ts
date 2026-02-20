import fs from "fs";
import path from "path";

/**
 * Paginates a devlog.md file by moving entries older than `maxAgeMs`
 * to a devlog_archive.md file in the same directory.
 *
 * Entries are delimited by `## YYYY-MM-DD` headers. Entries without
 * a parseable date are kept in the active devlog (safe default).
 *
 * The archive is append-only — older entries are added to the top
 * of the archive file, preserving chronological order within each
 * archival run.
 */

const ENTRY_HEADER_RE = /^## (\d{4}-\d{2}-\d{2})/;

interface DevlogEntry {
  /** Raw lines including the ## header */
  lines: string[];
  /** Parsed date from the header, or null if unparseable */
  date: Date | null;
}

/**
 * Parse a devlog file into individual entries.
 * Each entry starts with a `## YYYY-MM-DD` line.
 * Content before the first entry (e.g., `# Devlog` title) is treated
 * as a preamble and returned separately.
 */
function parseDevlog(content: string): { preamble: string[]; entries: DevlogEntry[] } {
  const lines = content.split("\n");
  const preamble: string[] = [];
  const entries: DevlogEntry[] = [];
  let current: DevlogEntry | null = null;

  for (const line of lines) {
    const match = line.match(ENTRY_HEADER_RE);
    if (match) {
      // Save previous entry
      if (current) entries.push(current);
      current = {
        lines: [line],
        date: new Date(match[1] + "T00:00:00Z"),
      };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  // Don't forget the last entry
  if (current) entries.push(current);

  return { preamble, entries };
}

/**
 * Paginate a devlog file: keep recent entries, archive old ones.
 *
 * @param devlogPath - Absolute path to devlog.md
 * @param maxAgeMs - Max age in milliseconds (default: 24 hours)
 * @returns Object with counts of kept and archived entries
 */
export function paginateDevlog(
  devlogPath: string,
  maxAgeMs = 24 * 60 * 60 * 1000
): { kept: number; archived: number } {
  if (!fs.existsSync(devlogPath)) {
    return { kept: 0, archived: 0 };
  }

  const content = fs.readFileSync(devlogPath, "utf-8");
  const { preamble, entries } = parseDevlog(content);

  if (entries.length === 0) {
    return { kept: 0, archived: 0 };
  }

  const cutoff = new Date(Date.now() - maxAgeMs);
  const keep: DevlogEntry[] = [];
  const archive: DevlogEntry[] = [];

  for (const entry of entries) {
    // Entries without a parseable date are kept (safe default)
    if (!entry.date || entry.date >= cutoff) {
      keep.push(entry);
    } else {
      archive.push(entry);
    }
  }

  if (archive.length === 0) {
    // Nothing to archive
    return { kept: keep.length, archived: 0 };
  }

  // Write archived entries to devlog_archive.md (append to existing)
  const archivePath = path.join(path.dirname(devlogPath), "devlog_archive.md");
  const archiveContent = archive.map((e) => e.lines.join("\n")).join("\n\n");

  if (fs.existsSync(archivePath)) {
    const existing = fs.readFileSync(archivePath, "utf-8");
    // Prepend new archive entries (they're older, but we want newest-first within archive)
    fs.writeFileSync(archivePath, archiveContent + "\n\n" + existing, "utf-8");
  } else {
    const header = "# Devlog Archive\n\nArchived entries older than 24 hours.\n\n";
    fs.writeFileSync(archivePath, header + archiveContent + "\n", "utf-8");
  }

  // Rewrite devlog.md with only recent entries
  const keepContent = keep.map((e) => e.lines.join("\n")).join("\n\n");
  const newDevlog = preamble.join("\n") + "\n\n" + keepContent + "\n";
  fs.writeFileSync(devlogPath, newDevlog, "utf-8");

  console.log(
    `[devlog-paginator] ${devlogPath}: kept ${keep.length}, archived ${archive.length} entries`
  );

  return { kept: keep.length, archived: archive.length };
}

/**
 * Paginate all devlog.md files found in the given directories.
 * Scans each directory (non-recursive) for a devlog.md file.
 */
export function paginateDevlogs(
  directories: string[],
  maxAgeMs = 24 * 60 * 60 * 1000
): void {
  const seen = new Set<string>();

  for (const dir of directories) {
    const devlogPath = path.join(dir, "devlog.md");
    // Deduplicate in case multiple sessions share the same working dir
    if (seen.has(devlogPath)) continue;
    seen.add(devlogPath);

    if (fs.existsSync(devlogPath)) {
      paginateDevlog(devlogPath, maxAgeMs);
    }
  }
}
