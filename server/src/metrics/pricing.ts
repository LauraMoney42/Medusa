/**
 * Per-token USD pricing for models whose CLI-reported `costUsd` cannot be
 * trusted: an OpenRouter model routed through the `claude` CLI harness
 * reports cost using Anthropic's own pricing table, which is wrong for a
 * non-Anthropic model. For those, recompute cost from token counts using
 * OpenRouter's own published price (its `/v1/models` response carries a
 * `pricing.prompt` / `pricing.completion` usd-per-token string per model).
 *
 * Native `claude` and `kimi` entries already carry a correct `costUsd` from
 * the CLI itself, so this module is consulted only for `provider === "openrouter"`.
 */

export interface ModelPricing {
  usdPerInputToken: number;
  usdPerOutputToken: number;
  /** False when we have no price data for this model; cost is reported as 0. */
  known: boolean;
}

const UNKNOWN_PRICING: ModelPricing = {
  usdPerInputToken: 0,
  usdPerOutputToken: 0,
  known: false,
};

/** modelId -> pricing. Populated by refreshOpenRouterPricing(); empty until then. */
const openRouterPricing = new Map<string, ModelPricing>();

let lastRefreshMs = 0;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Fetch OpenRouter's model catalog and cache usd-per-token pricing for each
 * model id. Safe to call repeatedly; a no-op within REFRESH_INTERVAL_MS of
 * the last successful fetch. Never throws — a failed fetch just leaves
 * pricing unknown (cost falls back to 0 with `known: false`).
 */
export async function refreshOpenRouterPricing(baseUrl = "https://openrouter.ai/api/v1"): Promise<void> {
  const now = Date.now();
  if (now - lastRefreshMs < REFRESH_INTERVAL_MS && openRouterPricing.size > 0) return;

  try {
    const res = await fetch(`${baseUrl}/models`);
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
    for (const m of body.data ?? []) {
      if (!m.id) continue;
      const prompt = m.pricing?.prompt ? parseFloat(m.pricing.prompt) : NaN;
      const completion = m.pricing?.completion ? parseFloat(m.pricing.completion) : NaN;
      if (!Number.isFinite(prompt) && !Number.isFinite(completion)) continue;
      openRouterPricing.set(m.id, {
        usdPerInputToken: Number.isFinite(prompt) ? prompt : 0,
        usdPerOutputToken: Number.isFinite(completion) ? completion : 0,
        known: true,
      });
    }
    lastRefreshMs = now;
  } catch (err) {
    console.warn("[metrics/pricing] Failed to refresh OpenRouter pricing:", err);
  }
}

/** Look up cached pricing for a given provider/model pair. Synchronous; never fetches. */
export function getModelPricing(provider: string | undefined, model: string | undefined): ModelPricing {
  if (provider !== "openrouter" || !model) return UNKNOWN_PRICING;
  return openRouterPricing.get(model) ?? UNKNOWN_PRICING;
}

/** Test-only: clear the cache and force the next refresh to re-fetch. */
export function _resetPricingCacheForTests(): void {
  openRouterPricing.clear();
  lastRefreshMs = 0;
}

/** Test-only: seed pricing without a network call. */
export function _setPricingForTests(model: string, pricing: ModelPricing): void {
  openRouterPricing.set(model, pricing);
}
