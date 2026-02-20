# PM Plan Template
**Use this template for every new plan before any code gets assigned.**
Both Product Manager and PM2 follow this standard.

---

## Mandatory PM Workflow (Both PMs — no exceptions)

Every new project or task assignment requires ALL THREE of the following:

### 1. Spec file in `docs/`
- Create spec at `docs/[feature_name]_spec.md`
- Use the template below

### 2. devlog.md entry (REQUIRED — not optional)
Write to `~/Medusa/devlog.md` immediately when you:
- Define or refine requirements
- Assign a task
- Make a prioritization decision
- Reprioritize or descope something
- Identify a risk or blocker

Format:
```
## YYYY-MM-DD HH:MM — [PM Bot Name]
**Task:** Brief description
**Status:** defined | assigned | in_review | reprioritized | descoped
**Assigned to:** [Role/Bot name]
**Notes:**
- What was decided and why
- Acceptance criteria or link to spec
- Any context the assignee needs
```
Rules: Always append — never edit or delete previous entries.

### 3. Project record in Medusa Projects pane (REQUIRED)
Immediately after creating a spec, POST to `/api/projects`:
```json
{
  "name": "Project Name",
  "description": "One-line description + spec path",
  "priority": "P0 | P1 | P2",
  "status": "in_progress"
}
```
Then assign the relevant dev(s) to the project. If you cannot make API calls directly, post to Hub asking @Full Stack Dev or @Backend Dev to create it immediately — do NOT proceed with task assignments until the Project record exists in the Projects pane.

**A project does not exist until all 3 are done.**

---

### 4. Security Review Gate (MANDATORY for releases)
Before ANY of the following, @Security MUST review and approve:
- App Store submission
- `git push` to main/production
- Any public-facing release

This is the ONLY time Security is tagged. Do not tag Security for routine dev work.
Format: [HUB-POST: @Security 🔒 Release review requested: [describe what's shipping]. Please review and approve before push/release.]

Security will review for: hardcoded secrets, auth vulnerabilities, XSS vectors, dependency issues, and any security policy violations.

**No release without Security sign-off. No exceptions.**

---

---

## Feature: [Name]
**Project:** Medusa
**Date:** YYYY-MM-DD
**Author:** [PM Bot Name]
**Assign to:** @[dev bot(s)]
**Priority:** P0 / P1 / P2 — [one-line justification]

---

## 1. Problem Statement

What problem are we solving? Who has it? 2 sentences max. If you can't articulate it, you don't understand it yet.

## 2. User Story

**As a** [type of user]
**I want** [what they want to do]
**So that** [why it matters]

The "so that" is the most important part. If it's weak, the feature probably isn't worth building. Multiple stories are fine for larger features.

## 3. Proposed Solution

High-level description of the approach. NOT implementation details — that's the dev's job. Just enough that everyone knows what we're building and the general direction.

## 4. Scope

**In:**
- What we ARE building

**Out:**
- What we are explicitly NOT building (and why)

This is where scope creep dies. No boundary = infinite work.

## 5. Acceptance Criteria

Testable conditions. Include happy path AND error states. If a dev can't verify it passed, it's too vague.

- [ ] Given [context], when [action], then [expected result]
- [ ] Given [context], when [action], then [expected result]
- [ ] Given [error condition], when [action], then [graceful handling]
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

**MANDATORY DEVLOG UPDATE — every dev must write to `devlog.md` after EVERY change, no exceptions:**
- [ ] Append a new entry to `~/Medusa/devlog.md` immediately upon task completion
- [ ] Entry MUST include a timestamp in format: `## YYYY-MM-DD HH:MM — [Bot Name]`
- [ ] Entry MUST include: Task description, Status, files affected, and brief notes on what changed and why
- [ ] Never edit or delete previous entries — append only
- [ ] Format:
  ```
  ## YYYY-MM-DD HH:MM — [Bot Name]
  **Task:** Brief description
  **Status:** completed | in_progress | blocked
  **Notes:**
  - What was changed and why
  - Files affected: list all modified files
  ```

**MANDATORY FOR ALL MEDUSA UI/SERVER TASKS — before tagging for verification:**
- [ ] Run full rebuild: `./scripts/rebuild.sh` (or manually: `npm run build` in client + server, then restart Medusa.app)
- [ ] Confirm the build succeeded on the LIVE running Medusa.app — not the dev server
- [ ] Do NOT tag @You until you have personally verified the change is visible in the running desktop app
- [ ] **QA NOTE: User is acting as QA for Medusa. Do NOT tag @QA/Testing or @QA2 on any tasks until further notice. Tag @You directly for all verification.**
- [ ] **NATIVE BUILDS ONLY (app/build-app.sh):** After every native rebuild, macOS TCC revokes Screen Recording permission. User must go to System Settings → Privacy & Security → Screen Recording → toggle Medusa OFF then ON. This is expected macOS behavior — not a bug. Include this instruction when tagging @You for native rebuild.
- [ ] **CANONICAL APP PATH:** Always launch from `~/Medusa/app/Medusa.app`. Any Desktop alias or old copy must be deleted. Dock should be pinned to the canonical path only. If user reports features missing after rebuild, verify they are launching from the correct path.

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| 1 | Description | @bot-name | None / T1 | S/M/L |
| 2 | Description | @bot-name | T1 | S/M/L |

Rules:
- Each task small enough to ship independently
- Dependencies flagged explicitly
- Assigned to the right role (UI Dev for frontend, Backend Dev / Full Stack Dev for server)

## 7. Success Criteria

How do we know this worked? Not "it shipped" — that's output. What's the OUTCOME?

- [Measurable outcome 1]
- [Measurable outcome 2]

## 8. Open Questions

Anything unresolved. Better to list what you don't know than pretend you have all the answers.

- [ ] Question 1
- [ ] Question 2

---

## What You Do NOT Need

- Wireframes (unless complex UI flow)
- Multi-page PRDs nobody reads
- Competitive analysis
- ROI projections
- Gantt charts
