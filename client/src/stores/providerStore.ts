import { create } from 'zustand';
import { fetchProviders, fetchProviderModels, type ProviderModel, type ProviderSummary } from '../api';

/**
 * Static fallback mirroring the server's built-in provider registry
 * (server/src/settings/providers.ts). Used when /api/providers or
 * /api/providers/:id/models can't be reached (offline, server not up yet),
 * so the picker keeps working instead of going blank.
 */
const STATIC_PROVIDERS: ProviderSummary[] = [
  { id: 'claude', displayName: 'Anthropic (native)', anthropicCompatible: false, hasApiKey: true },
  { id: 'kimi', displayName: 'Kimi', anthropicCompatible: false, hasApiKey: true },
  { id: 'openrouter', displayName: 'OpenRouter', anthropicCompatible: true, hasApiKey: false },
];

const STATIC_MODELS: Record<string, ProviderModel[]> = {
  claude: [
    { id: 'haiku', displayName: 'Haiku', cheap: true },
    { id: 'sonnet', displayName: 'Sonnet' },
    { id: 'opus', displayName: 'Opus' },
    { id: 'fable', displayName: 'Fable' },
  ],
  kimi: [{ id: 'kimi-k2', displayName: 'Kimi K2' }],
  openrouter: [
    { id: 'openai/gpt-5.1', displayName: 'GPT-5.1' },
    { id: 'openai/gpt-5.1-mini', displayName: 'GPT-5.1 Mini', cheap: true },
    { id: 'google/gemini-3-pro', displayName: 'Gemini 3 Pro' },
    { id: 'google/gemini-3-flash', displayName: 'Gemini 3 Flash', cheap: true },
    { id: 'deepseek/deepseek-v3.2', displayName: 'DeepSeek V3.2' },
    { id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5 (via OpenRouter)' },
  ],
};

interface ProviderState {
  providers: ProviderSummary[];
  modelsByProvider: Record<string, ProviderModel[]>;
  loaded: boolean;
  fetchProviders: () => Promise<void>;
  fetchModels: (providerId: string) => Promise<void>;
  modelsFor: (providerId: string) => ProviderModel[];
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: STATIC_PROVIDERS,
  modelsByProvider: STATIC_MODELS,
  loaded: false,

  fetchProviders: async () => {
    try {
      const { providers } = await fetchProviders();
      if (providers.length > 0) set({ providers, loaded: true });
    } catch {
      // Keep the static fallback already in state.
    }
  },

  fetchModels: async (providerId: string) => {
    try {
      const { models } = await fetchProviderModels(providerId);
      if (models.length > 0) {
        set((s) => ({ modelsByProvider: { ...s.modelsByProvider, [providerId]: models } }));
      }
    } catch {
      // Keep whatever static/cached list is already there.
    }
  },

  modelsFor: (providerId: string) => get().modelsByProvider[providerId] ?? [],
}));
