/**
 * Static registry of toolbox candidates.
 *
 * The addendum's Toolbox note is explicit: agents may search registries and
 * propose additions, but installs happen only on the user's click. So this is
 * a fixed list the "Search registry" modal filters, with no network call and
 * no auto-install. When a live registry lands, only this module changes.
 */

import type { ToolScope } from "./schema.js";

export interface RegistryCandidate {
  id: string;
  kind: "server" | "skill";
  label: string;
  detail: string;
  /** The narrowest scope the candidate actually needs. */
  suggestedScope: ToolScope;
  homepage: string;
}

export const REGISTRY_CANDIDATES: RegistryCandidate[] = [
  {
    id: "medusa-browser",
    kind: "server",
    label: "Browser (CDP)",
    detail: "Drive a real Chrome over the DevTools Protocol and stream frames into the chat.",
    suggestedScope: "write",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "medusa-simulator",
    kind: "server",
    label: "iOS Simulator (idb)",
    detail: "Boot, screenshot and tap through an iOS simulator.",
    suggestedScope: "write",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "medusa-files",
    kind: "server",
    label: "Local files",
    detail: "Read and edit files inside the chat's project folder.",
    suggestedScope: "write",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "medusa-shell",
    kind: "server",
    label: "Shell",
    detail: "Run commands in the project folder.",
    suggestedScope: "shell",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "filesystem",
    kind: "server",
    label: "Filesystem",
    detail: "Reference MCP server for reading a directory tree.",
    suggestedScope: "read",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "git",
    kind: "server",
    label: "Git",
    detail: "Inspect history, diffs and branches of a repository.",
    suggestedScope: "read",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "sqlite",
    kind: "server",
    label: "SQLite",
    detail: "Query a local SQLite database.",
    suggestedScope: "read",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "fetch",
    kind: "server",
    label: "Fetch",
    detail: "Retrieve a URL and hand back readable text.",
    suggestedScope: "read",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "code-review",
    kind: "skill",
    label: "Code review",
    detail: "Review a diff for correctness bugs and simplifications.",
    suggestedScope: "read",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "test-runner",
    kind: "skill",
    label: "Test runner",
    detail: "Run the project's test suite and summarize failures.",
    suggestedScope: "shell",
    homepage: "https://github.com/medusa-app/medusa",
  },
  {
    id: "release-notes",
    kind: "skill",
    label: "Release notes",
    detail: "Turn a range of commits into a readable changelog entry.",
    suggestedScope: "read",
    homepage: "https://github.com/medusa-app/medusa",
  },
];

/** Case-insensitive match over id, label and detail. Empty query returns all. */
export function searchRegistry(query: string): RegistryCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return REGISTRY_CANDIDATES;
  return REGISTRY_CANDIDATES.filter((c) =>
    `${c.id} ${c.label} ${c.detail}`.toLowerCase().includes(q)
  );
}
