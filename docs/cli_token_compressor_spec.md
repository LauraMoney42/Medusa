# CLI Token Compressor — Project Spec (P0)

**Status:** P0 — All Hands
**Created:** 2026-02-22
**Owner:** Product Manager
**Priority:** P0 — All other work paused until this ships

---

## Problem

Medusa's multi-bot architecture generates significant token overhead. Per the architecture review, each message costs 2,000-9,000 input tokens. Hub prompt injection alone adds ~1,400 tokens per turn. Existing optimizations (TO1-TO8: model routing, compact mode, conversation summarization, [BOT-TASK:] routing) have reduced costs but we're still burning tokens on bloated context.

Third-party token compression tools (RTK, repomix, etc.) introduce trust issues — they see our full conversation context, system prompts, and potentially sensitive data. Building in-house means zero third-party trust surface.

## Proposed Solution

An in-house CLI tool that compresses conversation context and repository content before it reaches Claude API calls. Sits upstream of the API layer — compresses input, not output.

## Architecture

```
[Raw Context] → [CLI Compressor] → [Compressed Context] → [Claude API]
                     ↑
              Config file (compression rules,
              exclusion patterns, safety limits)
```

### Core Compression Strategies (Rule-Based, Deterministic)

1. **Deduplication** — Remove repeated content blocks (hub messages, system prompts echoed across turns)
2. **Whitespace normalization** — Collapse excessive whitespace, normalize formatting
3. **Boilerplate stripping** — Remove low-value tokens (repeated timestamps, headers, sign-offs, pleasantries)
4. **Context windowing** — Keep recent N turns at full fidelity, summarize/compress older turns
5. **Semantic dedup** — Detect semantically similar blocks and keep only the most recent/complete version
6. **Code-aware compression** — For repo context: strip comments, collapse imports, abbreviate type signatures while preserving logic

### Integration Points

- `handler.ts` — Hook into `buildHubPromptSection()` before context injection
- `conversation-summarizer.ts` — Complement existing summarization with pre-summary compression
- `poll-scheduler.ts` — Compress context for poll/nudge messages (already using haiku, compress further)
- CLI standalone mode — Can also run independently on any text/JSON for manual compression

## Success Criteria

1. Measurable token reduction: minimum 30% on hub context injection, 20% on conversation history
2. Zero semantic loss on recent context (last 5 turns untouched by default)
3. Compression is deterministic and auditable (audit mode shows what was stripped)
4. No third-party dependencies for the compression logic itself
5. Build passes, existing Medusa functionality unaffected
6. Security sign-off on access rules and guardrails

## Scope

### In (MVP / v1)

- CLI binary (TypeScript, runs in Node — consistent with Medusa stack)
- Rule-based compression engine (strategies 1-4 above)
- Config file for tunable compression levels (conservative / moderate / aggressive)
- Audit mode: `--audit` flag shows diff of what was compressed
- Integration with `handler.ts` context pipeline
- Unit tests for each compression strategy
- Security guardrails (see below)

### Explicitly OUT (v1)

- ML-based / neural compression (future — too complex for v1)
- Real-time streaming compression (batch only for v1)
- Modification of Claude API calls themselves
- Semantic dedup (strategy 5) — requires embedding model, deferred
- Code-aware compression (strategy 6) — deferred to v2
- UI/dashboard for compression metrics (deferred)

## Security Guardrails (FINALIZED — from Security Bot RTK Assessment, 2026-02-22)

### Context: Why In-House
Security bot evaluated RTK (third-party Rust binary) and issued CAUTION — DO NOT DEPLOY:
- Anonymous maintainer, zero accountability
- Broad system access (intercepts ALL terminal output, writes to ~/.claude/settings.json, logs to SQLite)
- Output manipulation risk (sits between terminal and LLM)
- No binary integrity verification (no Sigstore/cosign, no reproducible builds)
- curl-pipe-sh installer

In-house eliminates all of these risks by design.

### Access Rules (MUST HAVE)
- Read-only access to stdout/stderr of wrapped command — compress, never modify source
- Output compression only — deterministic, auditable transformations (truncation, dedup, whitespace collapse)
- All processing strictly local, in-process — zero network calls
- Stateless by default — no persistent logging unless user explicitly opts in
- Config lives in single, user-visible file (e.g., `~/.claude-chat/compressor.json`)

### MUST NOT (Hard Rules — Violations = Security Halt)
- No writing to `~/.claude/settings.json` or `CLAUDE.md` — no self-installing hooks
- No modifying/suppressing command output silently — must append `[truncated: N lines]` marker when dropping content
- No persistent command history/logging by default — no SQLite DB tracking
- No auto-update mechanism — version pinned, user manually updates
- No shell execution of its own — wraps output only, does NOT re-execute or interpret commands
- No reading files beyond stdout/stderr of target command — no filesystem scanning
- Config file MUST NOT be writable by the tool itself
- Compression rules MUST be deterministic — same input always produces same output
- Tool MUST NOT strip security-relevant content (auth headers, permission checks, security warnings)

### 5 Required Guardrails (from Security Assessment — ALL must pass)
1. **Transparency** — Compressed output must show ratio and what was removed (e.g., `[compressed: 847->203 lines, removed: duplicate blank lines, ANSI codes, repeated patterns]`)
2. **Passthrough mode** — `--raw` flag to bypass compression entirely for debugging
3. **Secret detection** — Flag patterns matching API keys/tokens/env vars for LLM to avoid echoing. Flag, don't silently strip.
4. **No global hooks** — Invoked explicitly per-command (`compress <cmd>`), never auto-injected into all Bash calls
5. **Auditable** — Single file, <500 LOC, no external dependencies beyond standard lib

### Security Sign-Off Required
@Security must review final implementation against all 5 guardrails + MUST NOT rules before shipping. No exceptions.

## Task Breakdown

### Phase 1: Foundation (Session 1)
| Task | Assignee | Description |
|------|----------|-------------|
| TC-1 | Full Stack Dev | Core compression engine: dedup, whitespace normalization, boilerplate stripping |
| TC-2 | Full Stack 2 | Config system: compression levels, exclusion patterns, safety limits |
| TC-3 | Security | Finalize guardrails spec, define test cases for security boundaries |

### Phase 2: Integration (Session 2)
| Task | Assignee | Description |
|------|----------|-------------|
| TC-4 | Full Stack Dev | Integration with handler.ts — hook compressor into buildHubPromptSection() |
| TC-5 | Full Stack 2 | Context windowing: recent turns at full fidelity, older turns compressed |
| TC-6 | Backend Dev | CLI standalone mode: `npx medusa-compress --input <file> --level moderate --audit` |

### Phase 3: Testing & Ship (Session 3)
| Task | Assignee | Description |
|------|----------|-------------|
| TC-7 | Full Stack Dev | Unit tests for all compression strategies |
| TC-8 | Security | Security review: guardrails compliance, penetration test on access boundaries |
| TC-9 | Full Stack 2 | Metrics: before/after token counts, compression ratio logging |
| TC-10 | @You | Final verification and sign-off |

## Dev Assignments

| Developer | Role | Tasks |
|-----------|------|-------|
| Full Stack Dev | Primary — core engine + integration | TC-1, TC-4, TC-7 |
| Full Stack 2 | Config + windowing + metrics | TC-2, TC-5, TC-9 |
| Backend Dev | CLI interface | TC-6 |
| Security | Guardrails + security review | TC-3, TC-8 |
| UI Dev | On standby — no UI work in v1 | — |
| UI2 | On standby — no UI work in v1 | — |

## Open Questions

1. **@Security** — What specific content types must NEVER be compressed? (e.g., security verdicts, auth tokens, escalation messages)
2. **Compression target** — Is 30% hub context reduction ambitious enough, or should we target higher?
3. **Backward compatibility** — Should compressed context include a header/marker so bots know it's compressed?
4. **Rollback** — If compression causes a bot to misunderstand context, how do we detect and roll back?

## Timeline

- Session 1: Foundation (TC-1, TC-2, TC-3) — parallel work
- Session 2: Integration (TC-4, TC-5, TC-6) — depends on TC-1
- Session 3: Testing + ship (TC-7, TC-8, TC-9, TC-10)
- Estimated: 3 sessions to ship MVP

---

*This is a P0 project. All other work is paused until this ships. No exceptions.*
