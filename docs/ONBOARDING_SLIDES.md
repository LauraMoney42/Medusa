# Medusa — Onboarding Slide Deck
**Content & Copy for Welcome/Onboarding Screens**

Created: February 19, 2026
Author: Marketing
Reference: POTS Buddy OnboardingView.swift pattern (11-slide TabView)

---

## Implementation Notes

**Pattern:** Match POTS Buddy's OnboardingView.swift exactly:
- `TabView` with `.page` style, hidden default indicators
- Custom page indicator dots (8px circles, spring animation on active)
- Back / Next / Get Started buttons
- Skip button (top-right, hidden on final slide)
- `@Binding var hasCompletedOnboarding: Bool`

**Visual Style:**
- Brand color: Medusa purple/dark theme (match app's existing color palette)
- Icons: SF Symbols
- Icon size: 80pt
- Title: `.largeTitle`, bold
- Subtitle: `.title3`, brand accent color
- Description: `.body`, secondary color
- Background: Subtle gradient (dark → system background)

---

## Slide Content

---

### Slide 1 — Welcome

**Icon:** `sparkles` (purple)
**Title:** Welcome to Medusa
**Subtitle:** Your AI team, ready to work.
**Description:**
Medusa is a multi-bot orchestration platform that lets you run a coordinated team of AI agents — all working together, in real time, on your projects.

---

### Slide 2 — Meet Your Team

**Icon:** `person.3.fill` (blue)
**Title:** How Your Team Works
**Subtitle:** Medusa leads. PMs coordinate. Bots execute.
**Description:**
Every team starts with **Medusa** — your lead orchestrator. She receives your goals, delegates work to **Product Managers**, who break tasks down and assign them to specialist bots. You stay in control while the team handles the details.

*Visual suggestion: Simple hierarchy diagram*
```
        You
         ↓
      Medusa
         ↓
   PM  ·  PM2
    ↓         ↓
Dev · UI · Backend · Security · Marketing ...
```

---

### Slide 3 — Creating Bots

**Icon:** `plus.circle.fill` (green)
**Title:** Build Your Team
**Subtitle:** Each bot is a specialist.
**Description:**
Tap **New Session** in the sidebar to create a bot. Give it a name, a working directory, and custom instructions that define its role. Need a code reviewer? A designer? A marketer? Create a bot for it.

*Key points:*
- Each bot is an independent Claude session
- Name it clearly — bots address each other by name
- Instructions shape the bot's personality and focus
- You can create as many bots as your project needs

---

### Slide 4 — The Hub

**Icon:** `bubble.left.and.bubble.right.fill` (orange)
**Title:** The Hub
**Subtitle:** Where your team stays in sync.
**Description:**
The **Hub** is a shared message board visible to every bot on your team. Bots post updates, flag blockers, hand off work, and coordinate — all in one place. Tap **Hub** in the sidebar to view the live feed or post a message yourself.

*Key conventions:*
- Bots tag teammates with `@BotName` to route work
- Bots escalate to you with 🚨 **APPROVAL NEEDED** when they need a decision
- The last 20 Hub messages are included in every bot's context automatically

---

### Slide 5 — Instructions & Skills

**Icon:** `slider.horizontal.3` (teal)
**Title:** Customize Every Bot
**Subtitle:** Instructions define behavior. Skills extend capability.
**Description:**
**Instructions** are custom guidance that shape how a bot thinks and responds — added once, applied to every message. **Skills** are optional Claude extensions (like web search or code execution) you can toggle on per bot.

*To configure:* Right-click any bot in the sidebar → **Edit** → set Instructions and add Skills.

---

### Slide 6 — Projects & Tasks

**Icon:** `checklist` (indigo)
**Title:** Projects Keep Work Organized
**Subtitle:** Track progress across your entire team.
**Description:**
Create a **Project** to give your team a shared goal. Assign tasks to specific bots, set priorities (P0/P1/P2), and watch progress update automatically as bots complete work.

The **Kanban board** in each chat window shows every bot's current status at a glance:
- 🟡 **Thinking** — planning the task
- 🔵 **Doing** — actively working
- 🟢 **Done** — complete

---

### Slide 7 — Caffeine

**Icon:** `cup.and.saucer.fill` (brown/amber)
**Title:** Keep the Work Going
**Subtitle:** Caffeine prevents your Mac from sleeping.
**Description:**
For long-running tasks, turn on **Caffeine** using the toggle in the top-right corner. It keeps your Mac awake so your bots can work uninterrupted — even overnight.

Toggle it off when you're done to restore normal sleep behavior.

---

### Slide 8 — Staying in Control

**Icon:** `shield.checkered` (red)
**Title:** You're Always in Charge
**Subtitle:** Bots work autonomously, but never without you.
**Description:**
Bots will pick up new tasks automatically, coordinate with each other, and report progress to the Hub. When something needs your approval — a decision only you can make — a bot will escalate with a clear 🚨 alert in the Hub.

Use **Stop All** in the sidebar at any time to gracefully pause the entire team.

*Tip: Tag any bot directly by typing `@BotName` in any chat or Hub message.*

---

### Slide 9 — You're Ready

**Icon:** `checkmark.seal.fill` (purple)
**Title:** Let's Get Started
**Subtitle:** Your AI team is waiting.
**Description:**
Start by creating your first bot, or open the Hub to see your team in action. Medusa is ready when you are.

*A note on expectations:* Medusa coordinates AI agents to help you move faster — but always review important decisions and outputs before acting on them.

---

## Summary Table

| # | Slide Title | Icon | Color | Core Message |
|---|-------------|------|-------|--------------|
| 1 | Welcome to Medusa | `sparkles` | Purple | What Medusa is |
| 2 | How Your Team Works | `person.3.fill` | Blue | Medusa → PM → Bots hierarchy |
| 3 | Build Your Team | `plus.circle.fill` | Green | Creating bots, naming, instructions |
| 4 | The Hub | `bubble.left.and.bubble.right.fill` | Orange | Shared board, @mentions, escalation |
| 5 | Customize Every Bot | `slider.horizontal.3` | Teal | Instructions + Skills config |
| 6 | Projects & Tasks | `checklist` | Indigo | Projects, assignments, Kanban |
| 7 | Caffeine | `cup.and.saucer.fill` | Amber | Keep Mac awake for long runs |
| 8 | Staying in Control | `shield.checkered` | Red | Autonomy + escalation + Stop All |
| 9 | Let's Get Started | `checkmark.seal.fill` | Purple | CTA, disclaimer |

---

## Recommended OnboardingPage Struct (Swift)

```swift
struct OnboardingPage {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let description: String
}

let pages: [OnboardingPage] = [
    OnboardingPage(
        icon: "sparkles",
        iconColor: .purple,
        title: "Welcome to Medusa",
        subtitle: "Your AI team, ready to work.",
        description: "Medusa is a multi-bot orchestration platform that lets you run a coordinated team of AI agents — all working together, in real time, on your projects."
    ),
    OnboardingPage(
        icon: "person.3.fill",
        iconColor: .blue,
        title: "How Your Team Works",
        subtitle: "Medusa leads. PMs coordinate. Bots execute.",
        description: "Every team starts with Medusa — your lead orchestrator. She delegates to Product Managers, who assign tasks to specialist bots. You stay in control while the team handles the details."
    ),
    OnboardingPage(
        icon: "plus.circle.fill",
        iconColor: .green,
        title: "Build Your Team",
        subtitle: "Each bot is a specialist.",
        description: "Tap New Session in the sidebar to create a bot. Give it a name, a working directory, and instructions that define its role. Need a code reviewer? A designer? Create a bot for it."
    ),
    OnboardingPage(
        icon: "bubble.left.and.bubble.right.fill",
        iconColor: .orange,
        title: "The Hub",
        subtitle: "Where your team stays in sync.",
        description: "The Hub is a shared message board visible to every bot. Bots post updates, flag blockers, and hand off work — all in one place. Tap Hub in the sidebar to view the live feed."
    ),
    OnboardingPage(
        icon: "slider.horizontal.3",
        iconColor: .teal,
        title: "Customize Every Bot",
        subtitle: "Instructions define behavior. Skills extend capability.",
        description: "Instructions shape how a bot thinks and responds. Skills are optional Claude extensions you can toggle on per bot. Right-click any bot → Edit to configure."
    ),
    OnboardingPage(
        icon: "checklist",
        iconColor: .indigo,
        title: "Projects & Tasks",
        subtitle: "Track progress across your entire team.",
        description: "Create a Project to give your team a shared goal. Assign tasks to bots, set priorities (P0/P1/P2), and watch the Kanban board update automatically as work is completed."
    ),
    OnboardingPage(
        icon: "cup.and.saucer.fill",
        iconColor: Color(red: 0.6, green: 0.4, blue: 0.2),
        title: "Keep the Work Going",
        subtitle: "Caffeine prevents your Mac from sleeping.",
        description: "For long-running tasks, turn on Caffeine using the toggle in the top-right corner. It keeps your Mac awake so bots can work uninterrupted — even overnight."
    ),
    OnboardingPage(
        icon: "shield.checkered",
        iconColor: .red,
        title: "You're Always in Charge",
        subtitle: "Bots work autonomously, but never without you.",
        description: "Bots coordinate and report to the Hub automatically. When a decision needs your input, a bot will escalate with a 🚨 alert. Use Stop All in the sidebar to pause the team anytime."
    ),
    OnboardingPage(
        icon: "checkmark.seal.fill",
        iconColor: .purple,
        title: "Let's Get Started",
        subtitle: "Your AI team is waiting.",
        description: "Create your first bot, or open the Hub to see your team in action. Medusa is ready when you are. Always review important outputs before acting on them."
    )
]
```

---

## Design Notes for Developer

1. **Match POTS Buddy pattern exactly** — reuse the same `TabView` + custom dots + Back/Next/Skip navigation. Only change colors and content.
2. **Brand color** — use Medusa's existing accent color (dark purple / neon wherever appropriate) instead of POTS Buddy's hot pink.
3. **Slide 2 hierarchy diagram** — consider a simple custom SwiftUI view (3 rows of text with arrows) rather than an image asset. Keeps it lightweight and theme-aware.
4. **Skip button** — keep on all slides except the last (same as POTS Buddy).
5. **Persistence** — store `hasCompletedOnboarding` in `UserDefaults` so it only shows once.
6. **"Reopening" the guide** — consider adding a "Replay Onboarding" option in Settings so users can revisit it later.

---

*Created by KindCode Marketing | February 19, 2026*
*Reference: ~/Projects/POTS Buddy/POTS Buddy/Views/OnboardingView.swift*
