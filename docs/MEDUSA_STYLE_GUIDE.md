# Medusa Style Guide
**Version:** 1.0
**Last Updated:** 2026-02-17
**Owner:** Design / VP Admin

---

## 1. Brand Personality

Medusa is a **professional, serious, project-focused** AI orchestration tool. It is not playful or casual. Think: a Bloomberg terminal meets macOS — powerful, dense with information, but beautiful.

**Tone keywords:** Focused. Intelligent. Calm. Precise. Powerful.
**NOT:** Fun, bubbly, colorful, gamified, or consumer-app-ish.

---

## 2. Color Palette

### Primary
| Name | Hex | Usage |
|------|-----|-------|
| Medusa Green | `#1A4D2E` | Primary brand color, active states, key CTAs |
| Medusa Green Light | `#2D6A4F` | Hover states, secondary actions |
| Medusa Green Muted | `#52796F` | Borders, dividers, subtle accents |

### Neutrals
| Name | Hex | Usage |
|------|-----|-------|
| Background Dark | `#0D0D0D` | App background |
| Surface | `#1A1A1A` | Cards, panels, sidebars |
| Surface Elevated | `#242424` | Popovers, modals, dropdowns |
| Border | `#2E2E2E` | Dividers, input borders |
| Text Primary | `#F5F5F5` | Primary text |
| Text Secondary | `#A0A0A0` | Secondary/muted text, labels |
| Text Tertiary | `#606060` | Disabled states, placeholders |

### Status Colors
| Name | Hex | Usage |
|------|-----|-------|
| Success | `#2D6A4F` | Completed, online, passing |
| Warning | `#B5873A` | In progress, caution |
| Error | `#8B2E2E` | Failed, offline, critical |
| Info | `#2E4D8B` | Informational, neutral status |

### Priority Colors
| Name | Hex | Usage |
|------|-----|-------|
| P0 Critical | `#8B2E2E` | P0 badges |
| P1 High | `#B5873A` | P1 badges |
| P2 Normal | `#2E4D8B` | P2 badges |

---

## 3. Typography

- **Font Family:** System font stack — SF Pro (macOS), fallback to `-apple-system`
- **No custom fonts** — always use native system fonts for that Apple-native feel

| Role | Size | Weight | Usage |
|------|------|--------|-------|
| Title | 20px | 600 | Page/section titles |
| Heading | 16px | 600 | Card headers, bot names |
| Body | 14px | 400 | General content, messages |
| Caption | 12px | 400 | Timestamps, metadata, labels |
| Mono | 13px | 400 | Code, IDs, technical values (SF Mono) |

---

## 4. Iconography & Graphics

### Rules
- **All icons must be vector SVG** — no raster images for UI icons
- **Color:** Greyscale only (`#A0A0A0` to `#F5F5F5`) — no full-color icons
- **Style:** Line icons preferred, consistent stroke weight (1.5px)
- **Size:** 16px standard, 20px for primary actions, 12px for inline/caption

### The Medusa Logo/Mascot
- The Medusa snake/logo is the **only** full branded illustration
- Use it sparingly — app icon, splash, empty states only
- Never stretch, recolor, or alter proportions

### Emoji
- **Allowed:** Chat/messaging context only (bot conversations, Hub messages)
- **NOT allowed:** UI chrome, buttons, labels, status indicators, navigation items
- Status should use colored dots/badges, NOT emoji

### Illustrations / Images
- When needed (empty states, onboarding): greyscale or Medusa Green tinted only
- No full-color stock illustrations or cartoon-style graphics

---

## 5. Components & Patterns

### Glass / Blur Effects
- Use macOS-style vibrancy/blur for modals, popovers, and floating panels
- Background: `rgba(26, 26, 26, 0.85)` with `backdrop-filter: blur(20px)`
- Border: `1px solid rgba(255,255,255,0.08)`

### Cards
- Background: `#1A1A1A`
- Border: `1px solid #2E2E2E`
- Border radius: `8px`
- Padding: `12px 16px`
- Hover: subtle border brighten to `#3E3E3E`

### Buttons
| Type | Style |
|------|-------|
| Primary | Medusa Green background, white text, 6px radius |
| Secondary | Transparent, `#2E2E2E` border, muted text |
| Destructive | `#8B2E2E` background, white text |
| Ghost | No background, no border, text only |

### Input Fields
- Background: `#0D0D0D`
- Border: `1px solid #2E2E2E`
- Focus border: Medusa Green `#2D6A4F`
- Border radius: `6px`
- No drop shadows on inputs

### Status Dots
- 8px filled circle
- Colors: Green (online/active), Yellow (busy/in-progress), Red (offline/error)
- No pulse animations unless critical alert

### Scrollbars
- Thin, auto-hide macOS style
- Track: transparent
- Thumb: `#3E3E3E`

---

## 6. Motion & Animation

- **Subtle only** — no bouncy or playful animations
- Transitions: `150-200ms ease-in-out`
- Hover states: instant or `100ms`
- Modal open/close: `200ms` fade + subtle scale (`0.98 → 1.0`)
- No looping animations except loading spinners

---

## 7. Layout & Spacing

- Base unit: `4px`
- Common spacing: `4, 8, 12, 16, 24, 32px`
- Sidebar width: `240px` (collapsed: `48px`)
- Chat pane min-width: `320px`
- Always respect macOS traffic light button safe zone (top-left `72px`)

---

## 8. What Would Apple Do?

When in doubt, ask: **"What would Apple do?"**

- Clean over cluttered
- Whitespace is not wasted space
- Respect the platform — use native controls where possible
- Information hierarchy over decoration
- Function first, beauty second (but beauty matters)

---

## 9. Anti-Patterns (Never Do This)

- ❌ Full-color emoji in UI chrome
- ❌ Bright/saturated accent colors (no neon, no gradients unless extremely subtle)
- ❌ Drop shadows heavier than `0 2px 8px rgba(0,0,0,0.4)`
- ❌ Comic Sans, Papyrus, or any non-system font
- ❌ Rounded corners > `12px` on most components (except pills/badges: `999px`)
- ❌ Animations > `300ms`
- ❌ More than 3 font sizes on a single screen
- ❌ Colored backgrounds on text (except status badges)
- ❌ Full-color stock photos or illustrations

---

## 10. POTS Buddy Style Guide

POTS Buddy has its own separate style guide — see `~/Projects/POTS Buddy/BRAND_GUIDE.md`. Do not apply Medusa styling to POTS Buddy.

---

*This document is the source of truth for all Medusa UI decisions. When in doubt, check here first. If something isn't covered, flag it to VP Admin (Medusa bot) to update the guide.*
