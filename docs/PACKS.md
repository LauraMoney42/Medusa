# Medusa packs

A pack is everything that makes an install yours: the persona, your rules, the
theme, the voice and the toolbox. It travels as one JSON file with the
extension `.medusa-pack`, so a setup can be handed to someone else the way
editor themes are traded.

Nothing in a pack is engine specific. Everything it writes lands in
`~/.medusa/`, which `server/src/sessions/orchestrator-prompt.ts` composes into
the single system prompt every engine receives, so an imported persona behaves
the same on Claude, Kimi, an OpenRouter model or an ACP agent.

## The `~/.medusa/` layout

| Path | What it holds |
|------|---------------|
| `MEDUSA.md` | Persona: `---` front matter with `name` and `greeting`, then the personality prose. Only the prose reaches the prompt. |
| `rules/*.md` | One user rule per file, appended to the prompt alphabetically. |
| `rules.json` | Which rule files are enabled: `{ "adhd-mode.md": false }`. A rule with no entry is enabled. |
| `theme.json` | Color tokens, light/dark mode, density, optional font stack, optional avatar. |
| `voice.json` | TTS engine, voice id, speed, pitch, and whether replies are spoken by default. |
| `toolbox.json` | MCP servers and skills that are on by default, each with a permission scope. |
| `packs/` | Imported `.medusa-pack` files. |
| `backups/` | One snapshot per import, so trying a pack is never a one-way door. |

## File format

```jsonc
{
  "formatVersion": 1,
  "manifest": {
    "name": "Midnight Medusa",
    "version": "1.0.0",
    "author": "kind",
    "description": "Quiet colors, terse replies",
    "license": "MIT"
  },
  "persona": {
    "name": "Medusa",
    "greeting": "What are we shipping?",
    "personality": "You are Medusa, a hands-on coding assistant...",
    "avatar": "data:image/png;base64,..."   // or null
  },
  "rules": [
    { "name": "adhd-mode.md", "content": "Short, action-first replies.", "enabled": true }
  ],
  "theme": {
    "mode": "dark",
    "background": "#1c1c1e",
    "surface": "#2c2c2e",
    "accent": "#1a7a3c",
    "text": "#e5e5ea",
    "muted": "#8e8e93",
    "danger": "#c0392b",
    "font": "",
    "density": "comfortable",
    "avatar": null
  },
  "voice": {
    "engine": "kokoro",
    "voiceId": "af_heart",
    "speed": 1,
    "pitch": 1,
    "enabled": false
  },
  "toolbox": {
    "servers": [
      { "id": "git", "label": "Git", "detail": "", "enabled": true, "scope": "read" }
    ],
    "skills": []
  }
}
```

Validation lives in `server/src/packs/schema.ts` (zod). The rules worth knowing:

- `formatVersion` must be exactly `1`.
- Colors must be `#abc` or `#aabbcc`. A CSS color name is rejected.
- Rule file names must match `[A-Za-z0-9._-]+\.md` and may not start with a
  dot, so a pack cannot write outside `~/.medusa/rules`.
- An avatar must be a base64 data URL for a png, jpeg, gif or webp, under 2MB.
  `image/svg+xml` is refused because an SVG can carry script.
- `scope` is one of `read` (look, do not change), `write` (may edit files) or
  `shell` (may also run commands). It defaults to `read`.
- Voice `speed` and `pitch` are clamped to 0.5 to 2.

Unknown top-level parts are dropped rather than rejected, so an older Medusa
can still read a pack a newer one wrote as long as the format version matches.

## Importing and exporting

Settings has a Packs tab: export the current setup with a name, author and
description, or import a file. A `.medusa-pack` dropped anywhere on the window
is imported too.

Import is transactional in one direction only: the current setup is written to
`~/.medusa/backups/<timestamp>/pack.json` before anything is overwritten, and
an invalid pack is rejected with a list of problems without touching what is
already there. Rules are replaced rather than merged, so an imported pack gives
exactly the set its author shipped.

## Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET, PUT | `/api/medusa/persona` | Read or write the persona |
| POST | `/api/medusa/persona/reset` | Drop the user persona, back to the bundled one |
| GET | `/api/medusa/preview` | The composed prompt an engine would receive |
| GET | `/api/medusa/rules` | List rule files with content and on/off state |
| POST | `/api/medusa/rules` | Create a rule file |
| PUT | `/api/medusa/rules/:name/enabled` | Toggle one rule |
| DELETE | `/api/medusa/rules/:name` | Delete a rule file |
| GET | `/api/medusa/rules/effective` | The rule bodies the next turn will carry |
| GET, PUT | `/api/medusa/theme` | Theme tokens |
| GET, PUT | `/api/medusa/voice` | Voice settings |
| GET, PUT | `/api/medusa/toolbox` | Toolbox allowlist |
| GET | `/api/medusa/registry` | Candidate servers and skills. Proposes only |
| GET | `/api/packs` | Installed packs |
| POST | `/api/packs/export` | Snapshot the current setup as a pack |
| POST | `/api/packs/import` | Validate, back up, and apply a pack |
| POST | `/api/packs/validate` | Validate without writing anything |
| POST | `/api/packs/:id/apply` | Re-apply an installed pack |
| DELETE | `/api/packs/:id` | Remove an installed pack file |
