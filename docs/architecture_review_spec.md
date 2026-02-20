# Medusa Architecture Review — Research Project

**Project:** Medusa — Architecture & Token Optimization Review
**Date:** 2026-02-18
**Author:** PM2
**Priority:** P1
**Status:** In progress — research phase
**Owner:** Full Stack Dev (primary researcher)
**QA Required:** No — deliverable is a written analysis report

---

## 1. Problem Statement

Medusa currently runs multiple Claude-powered bots in parallel, each with its own conversation session, system prompt, and token budget. The architecture works but may not be optimal for:
- **Token efficiency** — each bot maintains a full context window, Hub feed, and system prompt
- **Coordination overhead** — bots communicate via Hub (a shared text feed), which is re-sent to every bot on every poll cycle
- **Cost** — running 10+ Claude sessions simultaneously is expensive
- **Simplicity** — the current multi-session architecture may be over-engineered for what users actually need

**Core question:** Is there a fundamentally better architecture for "1-2 user entry points → multiple parallel autonomous agents" that achieves lower token usage, lower cost, and/or simpler coordination?

---

## 2. User Story

**As a** Medusa developer and user,
**I want** an honest assessment of whether the current architecture is optimal,
**So that** I can either validate the current approach or pivot to something better before investing more engineering time.

---

## 3. Research Scope

### What to Analyze

**A. Current Architecture Audit**
- Map the full request lifecycle: user input → bot dispatch → execution → response
- Count token usage per bot interaction (system prompt size, Hub context size, conversation history size)
- Identify the top 3-5 sources of token waste
- Document the current coordination model (Hub polling, socket events, etc.)

**B. Alternative Architectures**
Evaluate each of these against the current approach:

1. **Single orchestrator + tool-use agents** — One Claude session that dispatches work to lightweight tool-calling sub-agents (not full conversation sessions). Similar to Claude's computer use or tool-use patterns.

2. **Python-based orchestration (no Node.js)** — Replace the Node.js/React stack with a Python orchestrator (e.g., using Claude SDK, LangChain, CrewAI, AutoGen, or raw API calls). Evaluate if a simpler stack achieves the same result.

3. **Multi-model approach** — Use cheaper/faster models (Haiku, Kimi, Gemini, Llama, Mistral, DeepSeek) for routine tasks (status checks, Hub summaries, simple code generation) and reserve Claude Opus/Sonnet for complex reasoning. Evaluate token cost savings.

4. **Event-driven vs. polling** — Replace Hub polling with pure event-driven architecture (webhooks, pub/sub). Evaluate if this reduces token burn from repeated context re-reads.

5. **Shared context window** — Instead of N separate conversations, use a single conversation with role-tagged messages. Evaluate if this reduces total token usage vs. N parallel windows.

6. **Claude Projects / persistent memory** — Evaluate if Claude's Project feature or similar persistent memory could replace per-session system prompts and reduce repeated context.

7. **Hybrid: Claude + open-source models** — Use Claude for planning/coordination and open-source models (via Ollama, vLLM, etc.) for execution tasks. Evaluate cost/quality tradeoffs.

**C. Entry Point Simplification**
- Current: user types in individual bot chat windows OR posts to Hub
- Goal: 1-2 entry points maximum
- Evaluate: single command input that gets routed intelligently vs. current multi-window approach
- Evaluate: voice input, CLI-only mode, single chat with @mentions

**D. Token Usage Benchmarks**
- Measure (estimate) current token usage per typical workflow (e.g., "assign a feature to a dev bot, dev builds it, QA verifies")
- Estimate token usage for the same workflow under each alternative architecture
- Calculate cost comparison (Claude API pricing for Haiku/Sonnet/Opus vs. alternatives)

---

## 4. Deliverable

A written report at `docs/architecture_review_report.md` covering:

1. **Current State Analysis** — How Medusa works today, with token usage estimates
2. **Architecture Alternatives** — Each option evaluated with pros/cons/token estimates
3. **Recommendation** — Stay the course, pivot, or hybrid approach
4. **Migration Path** — If recommending changes, what's the incremental migration plan
5. **Cost Projections** — Estimated monthly token/API costs for current vs. recommended approach

**Format:** Markdown with clear sections, comparison tables, and a TL;DR executive summary at the top.

---

## 5. Acceptance Criteria

- [ ] Report covers ALL 7 alternative architectures listed above (A through G)
- [ ] Each alternative has: description, pros, cons, estimated token savings, feasibility rating (1-5)
- [ ] Current architecture token usage is estimated (per-bot, per-interaction, per-workflow)
- [ ] Cost comparison table included (current vs. top 2 alternatives)
- [ ] Entry point simplification analysis included
- [ ] Clear recommendation with reasoning
- [ ] Report is thorough — take MORE time than necessary, not less
- [ ] No code changes — this is research only
- [ ] Report delivered at `docs/architecture_review_report.md`

---

## 6. Task Breakdown

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| AR1 | Full code/architecture review of current Medusa codebase | Full Stack Dev | None | L |
| AR2 | Research alternative architectures (7 options) | Full Stack Dev | AR1 | L |
| AR3 | Token usage estimation and cost modeling | Full Stack Dev | AR1 | M |
| AR4 | Entry point simplification analysis | Full Stack Dev | AR1 | S |
| AR5 | Write final report with recommendations | Full Stack Dev | AR1-AR4 | L |

**All tasks assigned to Full Stack Dev.** This is a solo deep-research project.

**Timeline:** Take as long as needed. Thoroughness > speed. User explicitly said "take more time than necessary and that's ok."

---

## 7. Key Questions to Answer

1. Are we burning tokens on coordination overhead that could be eliminated?
2. Is there a simpler architecture that achieves "1-2 entry points → parallel autonomous agents"?
3. Would a multi-model approach (Claude + cheaper LLMs) significantly reduce costs without sacrificing quality?
4. Is Python-based orchestration fundamentally simpler/cheaper than our Node.js/React approach?
5. Should Medusa be a desktop app at all, or would a CLI/terminal-based approach be more token-efficient?

---

## 8. Research Resources

- Claude API pricing: https://docs.anthropic.com/en/docs/about-claude/pricing
- CrewAI: https://github.com/crewAIInc/crewAI
- AutoGen: https://github.com/microsoft/autogen
- LangChain: https://github.com/langchain-ai/langchain
- Kimi (Moonshot AI): https://www.moonshot.cn/
- DeepSeek: https://www.deepseek.com/
- Ollama (local models): https://ollama.ai/
- Claude computer use / tool use patterns: https://docs.anthropic.com/en/docs/agents-and-tools

---

## Notes

- This is NOT a code change project. Zero code modifications.
- The goal is intellectual honesty — if there's a better way, we want to know
- Don't optimize for "keeping Medusa as-is" — optimize for the best user experience at the lowest token cost
- Consider that the user's core need is: "I type instructions, multiple agents work in parallel, I see results"
- The desktop app UI is nice-to-have, not a requirement — if a simpler interface achieves the same thing, that's worth considering
