# Pre-Submission Copy Compliance Review

**Reviewer:** Dev3  
**Date:** 2026-06-14  
**Apps:** The Narrator, Quizzik  
**Scope:** App Store metadata, in-app purchase/paywall copy, About/Settings subscription text, free-tier limits, i18n (EN + ES).

## The Narrator

### Issues found & fixed

| Issue | Location | Fix |
|-------|----------|-----|
| Paywall trial body referenced a non-existent "Pro" tier and only one price. | `src/i18n/index.ts` `paywall.trialBody` | Updated to: "Enjoy unlimited narrations for 7 days. After that, choose Casual ($4.99/mo) or Unlimited ($9.99/mo)." (EN + ES). |
| Limit-reached copy said "this month" but backend limits are daily. | `src/i18n/index.ts` `paywall.limitReachedBody`, `paywall.remainingBody` | Changed to "today" / "de hoy" (EN + ES). |
| About subscription body implied the 7-day trial itself was limited to 3 narrations/day and Spanish said 2/day. | `src/i18n/index.ts` `about.subscriptionBody` | Clarified: trial is unlimited; after trial the free tier is 3/day. Fixed Spanish to 3/day. |
| Spanish free-tier count was 2/day while English was 3/day. | `src/i18n/index.ts` `tier.freeNarrations` | Aligned Spanish to "3 narraciones / día". |

### Open product decision (needs @You)

- **Trial entitlement mismatch:** App copy says "unlimited narrations for 7 days," but the backend `usageStore.js` sets `trial: { soft: 3, hard: 3 }`, i.e. 3 narrations/day. Before submission, either:
  1. Update backend to give trial users a true unlimited daily limit for 7 days, **or**
  2. Update all copy to describe the trial as "3 free narrations/day for 7 days" (or whatever the final model is).

Apple reviewers compare advertised trial terms against actual app behavior, so this must match.

## Quizzik

### Issues found & fixed

| Issue | Location | Fix |
|-------|----------|-----|
| Paywall displayed an "Upgrade" button that did not initiate a purchase (it just closed the modal). App Store reviewers reject non-functional purchase buttons. | `src/components/PaywallModal.tsx` | Removed the upgrade button. Modal now only shows the daily-limit message and a close button. |
| Paywall body text told users to "Upgrade for unlimited access" with no purchasable product. | `src/i18n/index.ts` `paywall.limitReachedBody` | Changed to: "You've used all {limit} free listens for today. Come back tomorrow for more." (EN + ES). |
| Metadata claimed a "premium subscription" was available, but no IAP products are configured. | `docs/APP_STORE_METADATA.md` | Updated pricing paragraph to state the app is free with daily limits and that optional premium subscriptions may be offered in the future. |

### Open product decision (needs @You)

- **In-app purchases for Quizzik:** If Quizzik launches without subscriptions, ensure all paywall/marketing copy does not promise paid upgrades. The current fix removes the misleading button; verify before submission that no other screen still references upgrading or subscriptions.

## Verification

- `npx tsc --noEmit` clean for both `TheNarrator` and `Quizzik` after changes.
- No functional purchase logic was changed; only copy and the disabled Quizzik upgrade button.

## Recommended next steps

1. @You: decide The Narrator free-trial entitlement model and align backend + copy.
2. @You: push these copy fixes along with the other queued commits.
3. Dev1/Dev3: after trial decision, update any remaining references to trial limits (paywall, About, Settings, metadata).
