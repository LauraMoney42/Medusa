# Token Optimization Research — Phase 3 & Advanced Techniques

**Date:** 2026-02-21
**Researcher:** Dev (medusa_dev-0026c6)
**Project:** Medusa Multi-Bot Orchestration System
**Status:** In Progress

---

## Executive Summary

This document analyzes advanced token optimization techniques beyond the already-implemented Phase 1+2 optimizations in Medusa. Current implementation includes tiered model routing (haiku/sonnet/opus), hub message filtering, idle bot hibernation, and terse communication protocols. This research focuses on:

1. **Conversation Summarization** (highest ROI for long-running sessions)
2. **Semantic Compression & Caching**
3. **Incremental Context Management**
4. **Token Usage Analytics & Monitoring**
5. **Next-Generation Optimizations**

---

## 1. Conversation Summarization (Phase 3, Task T8)

### Problem
Long-running bot sessions accumulate hundreds of messages. Currently, the full conversation history is sent to Claude on every interaction, consuming exponentially more tokens over time. A 50-message conversation can use 10K+ input tokens per message.

### Research Findings

#### Industry Approaches

**LangChain ConversationSummaryMemory:**
- Periodically summarizes conversation history using a cheaper model (e.g., haiku)
- Keeps recent messages verbatim, older messages as summaries
- Typical pattern: Last 10 messages raw + summary of everything before
- Compression ratio: 70-85% token reduction for long conversations

**AutoGPT Memory Management:**
- Maintains a "rolling window" of recent messages (default: 20)
- Older messages are compressed into timestamped summaries
- Uses a "relevance score" to keep important messages longer
- Threshold-based: summarize when conversation exceeds N tokens

**Anthropic Claude Best Practices:**
- Claude handles long contexts better than most models (200K context window)
- But cost scales linearly with input tokens — compression still valuable
- Recommendation: Keep last 15-20 exchanges raw, summarize older batches
- Use Claude Haiku to generate summaries (cheap + maintains quality)

#### Proposed Implementation for Medusa

**Strategy: Tiered Context Window**

```
[Summary of messages 1-30: One-paragraph overview]
[Summary of messages 31-50: One-paragraph overview]
[Messages 51-70: Full verbatim history]
```

**Triggering Criteria:**
- Threshold: Summarize when conversation exceeds 50 messages OR estimated 15K input tokens
- Frequency: After every 20 new messages once threshold is crossed
- Batch size: Summarize in chunks of 20-30 messages at a time

**Summarization Process:**
1. Extract messages 1-N (where N = total - 20, keeping last 20 raw)
2. Chunk into batches of 20-30 messages each
3. For each batch, call Claude Haiku with prompt:
   ```
   Summarize this conversation batch concisely. Include:
   - Key decisions made
   - Code/features implemented
   - Open questions or blockers
   - Task assignments/completions
   Keep it under 200 tokens. Be specific about what was built/decided.
   ```
4. Store summaries with timestamp ranges: `[Messages 1-20, 2026-02-15 10:00-11:30]: summary text`
5. Rebuild conversation context as: `[all summaries] + [last 20 raw messages]`

**Expected Savings:**
- 50-message conversation: ~12K input tokens → ~3K tokens (75% reduction)
- 100-message conversation: ~25K input tokens → ~4K tokens (84% reduction)
- Summarization cost: ~500 tokens (haiku pricing) per 20-message batch

**Implementation Complexity:** Medium
- New file: `server/src/chat/conversation-summarizer.ts` (already exists! Check implementation status)
- Update: `handler.ts` to check message count threshold and trigger summarization
- Storage: Add `summaries: SummaryBlock[]` to chat metadata
- UI: Optional "View Full History" button to expand summaries

**Risk Mitigation:**
- Keep summaries separate from raw messages (can always rebuild)
- Allow manual override: "Do not summarize this session" flag
- Log all summaries to devlog for transparency

---

## 2. Semantic Compression & Caching

### Problem
Bots receive repetitive information across sessions:
- Same system prompts on every message
- Repeated Hub messages ("still working on X")
- Duplicated code context (same file discussed multiple times)

### Research Findings

#### Prompt Caching (Anthropic Feature - Q2 2024)
Anthropic introduced **Prompt Caching** for Claude:
- Cache static portions of prompts (system instructions, code context)
- Cached tokens are 90% cheaper on subsequent calls
- Cache lasts 5 minutes, refreshed on each use
- Ideal for: bot system prompts, project documentation, large code files

**Application to Medusa:**
- System prompts (bot instructions) are identical across all messages in a session
- Hub context structure is repetitive (same format every poll)
- Code files under review are discussed across multiple messages

**Implementation:**
```typescript
// Mark cacheable sections in system prompt
const systemPrompt = `
<cacheable>
${botInstructions}  // Static bot role/rules
${projectContext}   // Static project overview
</cacheable>

<dynamic>
${hubMessages}      // Changes every call
${userMessage}      // Unique per request
</dynamic>
`;
```

**Expected Savings:**
- System prompt: ~3K tokens → 90% cheaper after first call
- Project documentation: ~2K tokens → 90% cheaper
- Average reduction: 30-40% on input tokens for multi-turn sessions

**Status:** Requires Claude API update (check if `--cache-prompt` flag exists in CLI)

#### Deduplication
Identify and collapse repeated content:
- If a hub message is identical to one sent 5 minutes ago, reference it instead of repeating
- If a code file is discussed multiple times, include it once with a note: "(already reviewed above)"

**Implementation Complexity:** Low-Medium
- Add fingerprinting to hub messages (hash of content)
- Track "recently sent" content IDs in session state
- Replace duplicates with references: `[Previously sent hub message #42]`

**Expected Savings:** 10-20% on hub-heavy sessions

---

## 3. Incremental Context Management

### Problem
Currently, the entire Hub feed (filtered to relevant messages) is sent on every interaction. If a bot is @mentioned 10 times in one hour, it receives overlapping hub context repeatedly.

### Research Findings

#### Delta-Based Context Updates
Instead of sending full context, send only what's new since the last interaction:

**Current approach:**
```
Bot receives on Message 1: [Hub messages 1-20]
Bot receives on Message 2: [Hub messages 1-25] ← 20 messages repeated
Bot receives on Message 3: [Hub messages 1-30] ← 25 messages repeated
```

**Delta-based approach:**
```
Bot receives on Message 1: [Hub messages 1-20] + "This is your first check."
Bot receives on Message 2: [Hub messages 21-25] + "New messages since last check."
Bot receives on Message 3: [Hub messages 26-30] + "New messages since last check."
```

**Caveat:** Claude doesn't retain conversation state perfectly across `--resume` sessions. We'd need to include a "context anchor" — a brief summary of what was previously sent:

```
Message 2:
[Previously reviewed: 20 hub messages, last was about task assignment to @UI Dev]
[New since then: 5 messages]
[Message 21: ...]
[Message 25: ...]
```

**Expected Savings:** 40-60% on hub context for active bots (heavily @mentioned)

**Implementation Complexity:** Medium-High
- Track `lastSeenHubMessageId` per bot (already exists in poll-scheduler!)
- Modify `buildHubPromptSection()` to accept `since: messageId` parameter
- Add context anchor summary

---

## 4. Token Usage Analytics & Monitoring

### Problem
We don't currently measure token usage, so we can't prove optimizations are working or identify new bottlenecks.

### Proposed Solution

#### Instrumentation
Log token counts per interaction:
- Input tokens (prompt + system + context)
- Output tokens (response)
- Model used (haiku/sonnet/opus)
- Interaction type (user message, poll, mention, nudge)
- Session ID and bot role

**Storage:**
```json
// token-usage.jsonl (append-only log)
{"timestamp": "2026-02-21T14:30:00Z", "sessionId": "pm-1", "type": "poll", "model": "haiku", "inputTokens": 450, "outputTokens": 12}
{"timestamp": "2026-02-21T14:31:00Z", "sessionId": "dev-1", "type": "user", "model": "sonnet", "inputTokens": 3200, "outputTokens": 850}
```

#### Dashboard (Future)
Simple aggregation queries:
- Total tokens per day/week
- Token breakdown by bot role (which bots are expensive?)
- Token breakdown by model tier (are we routing correctly?)
- Token breakdown by interaction type (are polls actually cheap?)
- Cost estimation (tokens × model pricing)

**Expected Value:**
- Quantify savings from optimizations ("50% reduction" becomes provable)
- Identify outliers ("Why is the PM bot using 10x more tokens than others?")
- Guide future optimization priorities

**Implementation Complexity:** Low-Medium
- Parse token counts from Claude CLI output (check if `--verbose` includes this)
- Append to JSONL log after each interaction
- Optional: simple CLI tool to query logs (`npm run token-report`)

---

## 5. Next-Generation Optimizations

### 5A. Embedding-Based Context Retrieval (Phase 4+)

**Concept:** Instead of dumping all hub messages or conversation history, use semantic search to retrieve only the most relevant context.

**How it works:**
1. Embed all hub messages and conversation turns using a cheap embedding model (e.g., OpenAI text-embedding-3-small)
2. Store embeddings in a vector database (Pinecone, Qdrant, or even in-memory FAISS)
3. When a bot needs context, embed the current query/task
4. Retrieve top-K most semantically similar messages (K=5-10)
5. Send only those K messages instead of all 20+

**Expected Savings:** 60-80% on hub context (only send what's relevant, not everything)

**Complexity:** High
- Requires embedding API calls (small cost, but added latency)
- Requires vector DB setup
- Needs careful tuning of retrieval parameters

**Recommendation:** Defer until Phase 1-3 are fully optimized and measured. Embedding-based retrieval is powerful but adds complexity.

### 5B. Request Batching

**Concept:** If multiple bots need to process the same hub message, batch their requests into a single Claude call with multiple questions.

**Example:**
```
Instead of:
- Call 1: "@UI Dev: Does this design look good?" → sonnet call
- Call 2: "@Backend Dev: Can the API support this?" → sonnet call
- Call 3: "@PM: Is this priority correct?" → sonnet call

Batch as:
"Answer these three questions:
1. [For UI Dev role] Does this design look good?
2. [For Backend Dev role] Can the API support this?
3. [For PM role] Is this priority correct?"
```

**Expected Savings:** 30-50% if multiple bots are mentioned in the same hub message

**Complexity:** High
- Requires detecting when multiple bots are mentioned in one message
- Requires parsing multi-part responses and routing to correct bots
- Risk of response quality degradation (Claude might conflate roles)

**Recommendation:** Experimental. Test with low-stakes messages first.

### 5C. Lazy Context Loading

**Concept:** Don't send code files, documentation, or project context unless the bot explicitly needs it.

**Current behavior:**
- Bot system prompt includes full project overview, tech stack, coding standards (~3K tokens)
- Sent on every message, even simple acknowledgments

**Optimized behavior:**
- Minimal prompt for simple operations: "You are Dev. Respond to this hub message."
- Full prompt only when bot is doing complex work: "You are Dev. [Full instructions]. Build this feature."

**Implementation:** Ties into Compact Mode (TO8) — already partially implemented

**Expected Savings:** 40-60% on system prompt tokens for routine operations

---

## 6. Prioritized Recommendations

### Immediate (Next Sprint)

1. **Conversation Summarization (T8)** — Highest ROI for long-running sessions
   - Implementation: 2-3 days
   - Expected savings: 70-85% on sessions with 50+ messages
   - Risk: Low (can always fallback to full history)
   - Owner: @Full Stack Dev

2. **Token Usage Logging** — Needed to measure everything else
   - Implementation: 1 day
   - Value: Quantifies all optimizations, identifies bottlenecks
   - Risk: None (read-only logging)
   - Owner: @Backend Dev

3. **Expand Compact Mode (TO8)** — Finish the partial implementation
   - Implementation: 1 day
   - Expected savings: 30-40% on routine operations
   - Risk: Low (already partially done)
   - Owner: @Full Stack Dev

### Near-Term (Within 1 Month)

4. **Prompt Caching** — If Claude CLI supports it
   - Implementation: 2 days (if API exists)
   - Expected savings: 30-40% on multi-turn sessions
   - Risk: Low (Anthropic feature, well-tested)
   - Owner: @Full Stack Dev
   - **Action:** Verify if `--cache-prompt` or similar flag exists in Claude CLI

5. **Delta-Based Hub Context** — Send only new messages since last check
   - Implementation: 3 days
   - Expected savings: 40-60% on hub context
   - Risk: Medium (need to ensure context continuity)
   - Owner: @Full Stack Dev

### Future / Experimental (Phase 4+)

6. **Embedding-Based Retrieval** — Semantic context selection
   - Implementation: 1-2 weeks
   - Expected savings: 60-80% on hub context
   - Risk: High (complexity, added dependencies)
   - Defer until Phase 1-3 fully deployed

7. **Request Batching** — Multi-bot questions in one call
   - Implementation: 1 week
   - Expected savings: 30-50% when applicable
   - Risk: High (response quality concerns)
   - Experimental only

---

## 7. Open Questions for @Medusa / PM

- [ ] **Token usage baseline:** Can we access Claude API usage logs to establish a pre-optimization baseline?
- [ ] **Prompt caching support:** Does the current Claude CLI version support prompt caching? Check `claude --help` for flags.
- [ ] **Summarization trigger:** Should summarization be automatic (threshold-based) or manual (user/PM triggered)?
- [ ] **Summarization model:** Use haiku for cheap summaries or sonnet for quality? (Recommend haiku.)
- [ ] **Context window limits:** Are we hitting any 200K token limits in practice? (Unlikely but worth checking.)
- [ ] **Performance vs cost tradeoff:** Is sub-second response time more important than token cost for certain bots?

---

## 8. Success Metrics

To evaluate Phase 3 implementations, track:

1. **Token Reduction Rate**
   - Target: 60-70% reduction on long-running sessions (50+ messages)
   - Target: 30-40% reduction on routine operations (polls, simple acks)
   - Measure: Total tokens per session before/after summarization

2. **Response Quality**
   - Metric: No degradation in task completion rate
   - Metric: No increase in "I don't have enough context" responses
   - Measure: Manual QA review of summarized sessions

3. **Cost Savings**
   - Target: 50%+ reduction in monthly Claude API spend
   - Measure: Weekly cost reports from Claude dashboard

4. **Latency**
   - Target: No increase in response time (summarization is async/backgrounded)
   - Measure: Time from user message sent → first token received

---

## 9. Implementation Roadmap

### Week 1: Measurement & Foundation
- ✅ Research complete (this document)
- [ ] Implement token usage logging
- [ ] Verify prompt caching CLI support
- [ ] Establish baseline metrics (current token usage)

### Week 2-3: Conversation Summarization (T8)
- [ ] Implement summarization logic in `conversation-summarizer.ts`
- [ ] Add threshold detection to `handler.ts`
- [ ] Test with 100-message mock session
- [ ] Deploy and monitor for one week

### Week 4: Compact Mode Expansion
- [ ] Finish compact prompt variants for all bot roles
- [ ] Add `compactMode` parameter to `buildHubPromptSection()`
- [ ] Apply to poll-scheduler and mention-router
- [ ] Measure token reduction

### Month 2: Delta Context & Prompt Caching
- [ ] Implement delta-based hub context updates
- [ ] Implement prompt caching (if supported)
- [ ] A/B test: 50% of bots use delta context, 50% use full context
- [ ] Compare token usage and response quality

### Month 3+: Advanced Techniques
- [ ] Prototype embedding-based retrieval (experimental)
- [ ] Evaluate request batching feasibility
- [ ] Long-term monitoring and tuning

---

## 10. Conclusion

Medusa's Phase 1+2 token optimizations (tiered routing, hub filtering, idle hibernation) have laid a strong foundation. The next wave of optimizations — **conversation summarization, prompt caching, and expanded compact mode** — can deliver an additional 50-70% token reduction for long-running sessions while maintaining output quality.

**Immediate Priority:** Implement conversation summarization (T8). It has the highest ROI and lowest risk.

**Measurement is Critical:** Deploy token usage logging before implementing Phase 3 to quantify savings and identify bottlenecks.

**Future Work:** Embedding-based retrieval and request batching are promising but complex. Defer until Phase 3 is proven and measured.

---

**Next Steps:**
1. Review this research document with @Medusa / PM
2. Get approval for Phase 3 implementation priorities
3. Assign tasks (T8, token logging, compact mode expansion)
4. Establish success metrics and measurement framework
5. Begin Week 1 implementation

**Files to Update:**
- `/docs/token_optimization_phase3_plan.md` ← Create this as formal spec
- `/server/src/chat/conversation-summarizer.ts` ← Check status, implement if incomplete
- `/server/src/utils/token-logger.ts` ← New file for usage logging
- `/server/src/socket/handler.ts` ← Add summarization trigger logic
