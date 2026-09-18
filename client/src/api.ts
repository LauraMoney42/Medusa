import type { SessionMeta } from './types/session';
import type { ChatMessage } from './types/message';
import type { ProjectSummary, Project, QuickTask } from './types/project';

// Auth is now handled via httpOnly cookie (set by /api/auth/login).
// credentials: 'include' tells the browser to send that cookie automatically.
// No token is read from localStorage here.

async function request<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    // Try to unwrap { error: "..." } JSON — avoids showing raw JSON blobs to users
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.message) throw new Error(parsed.message);
    } catch (e) {
      if (e instanceof SyntaxError === false) throw e; // re-throw our Error, not parse error
    }
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** POST the token to the server — server validates and sets the httpOnly cookie. */
export function login(token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

/** Clears the server-side auth cookie. */
export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

/**
 * Reads a `medusa-auth=<token>` entry out of the URL fragment left by the
 * desktop shell (see desktop/src-tauri/src/main.rs: the window is navigated
 * to `http://127.0.0.1:<port>/#medusa-auth=<token>` once the sidecar is
 * healthy). Fragments are never sent to the server, so this is the primary
 * handoff path; the shell's initialization_script localStorage write is only
 * a secondary path kept for engines where it still fires reliably.
 *
 * If found, stores it into localStorage under 'auth-token' (the same key
 * the init script writes) and strips the fragment from the visible URL via
 * history.replaceState, so the token never lingers in the address bar or
 * browser history.
 */
function consumeAuthTokenFromHash(): void {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;

  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('medusa-auth');
  if (!token) return;

  localStorage.setItem('auth-token', token);

  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(null, '', url.toString());
}

/**
 * Checks whether the current cookie is valid.
 * If not, attempts auto-login using the token handed off in the URL
 * fragment (see consumeAuthTokenFromHash) or, as a fallback, injected into
 * localStorage directly by the macOS app's initialization_script.
 * Returns true if authenticated, false otherwise.
 */
export async function checkAuth(): Promise<boolean> {
  consumeAuthTokenFromHash();

  try {
    await request<{ ok: boolean }>('/api/auth/me');
    return true;
  } catch {
    // Cookie missing or invalid: try the token the desktop shell handed off
    const injectedToken = localStorage.getItem('auth-token');
    if (injectedToken) {
      try {
        await login(injectedToken);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function fetchSessions(): Promise<SessionMeta[]> {
  return request<SessionMeta[]>('/api/sessions');
}

/** Fields accepted by POST /api/sessions. `workingDir` is required. */
export interface CreateSessionInput {
  workingDir: string;
  name?: string;
  engineId?: string;
  providerId?: string;
  model?: string;
  systemPrompt?: string;
}

export function createSession(input: CreateSessionInput): Promise<SessionMeta> {
  return request<SessionMeta>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Patch any subset of a chat's settings (title, folder, engine, provider, model). */
export function updateSession(
  id: string,
  patch: Partial<{
    name: string;
    systemPrompt: string;
    model: string | null;
    engineId: string | null;
    providerId: string | null;
    workingDir: string;
    /** S14-A: per-session voice-turn model override; null clears it. */
    voiceModel: string | null;
  }>,
): Promise<SessionMeta> {
  return request<SessionMeta>(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function renameSession(
  id: string,
  name: string,
): Promise<SessionMeta> {
  return request<SessionMeta>(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function deleteSession(id: string): Promise<void> {
  return request<void>(`/api/sessions/${id}`, { method: 'DELETE' });
}

/**
 * Sets (or clears) the per-chat model override. Pass null to clear it and fall
 * back to the provider's default routing.
 */
export function setSessionModel(
  id: string,
  model: string | null,
): Promise<SessionMeta> {
  return request<SessionMeta>(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ model }),
  });
}

export function reorderSessions(order: string[]): Promise<void> {
  return request<void>('/api/sessions/reorder', {
    method: 'PUT',
    body: JSON.stringify({ order }),
  });
}

export function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  return request<ChatMessage[]>(`/api/chat/${sessionId}/messages`);
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
}

export function fetchProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>('/api/projects');
}

export function fetchProject(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${id}`);
}

export function createProject(data: {
  title: string;
  summary: string;
  content: string;
  assignments?: Array<{ owner: string; task: string; status?: string }>;
}): Promise<Project> {
  return request<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateProject(
  id: string,
  data: Partial<{
    title: string;
    summary: string;
    content: string;
    status: string;
    priority?: 'P0' | 'P1' | 'P2' | 'P3';
    assignments: Array<{ owner: string; task: string; status: string }>;
  }>,
): Promise<Project> {
  return request<Project>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── Quick Tasks ──

export function fetchQuickTasks(): Promise<QuickTask[]> {
  return request<QuickTask[]>('/api/quick-tasks');
}

export function createQuickTask(data: {
  title: string;
  assignedTo: string;
}): Promise<QuickTask> {
  return request<QuickTask>('/api/quick-tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateQuickTask(
  id: string,
  data: Partial<Pick<QuickTask, 'title' | 'assignedTo' | 'status'>>,
): Promise<QuickTask> {
  return request<QuickTask>(`/api/quick-tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteQuickTask(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/quick-tasks/${id}`, { method: 'DELETE' });
}

export function fetchSkills(): Promise<{ skills: SkillInfo[]; ready: boolean }> {
  return request<{ skills: SkillInfo[]; ready: boolean }>('/api/skills');
}

export async function uploadImage(
  file: File,
): Promise<{ filePath: string }> {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch('/api/images', {
    method: 'POST',
    credentials: 'include', // httpOnly cookie auth
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed ${res.status}: ${body}`);
  }

  return res.json() as Promise<{ filePath: string }>;
}

export async function uploadFile(
  file: File,
): Promise<{ filePath: string }> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/files', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`File upload failed ${res.status}: ${body}`);
  }

  return res.json() as Promise<{ filePath: string }>;
}

// ---- Speech-to-text (mic button) ----

/** Whether the server has a transcription backend configured. */
export function fetchSttStatus(): Promise<{ enabled: boolean }> {
  return request<{ enabled: boolean }>('/api/stt/status');
}

/** Upload a mic recording and get back the transcribed text. */
export async function transcribeAudio(blob: Blob): Promise<{ text: string }> {
  const formData = new FormData();
  const ext = blob.type.includes('mp4') || blob.type.includes('mpeg') ? 'mp4' : 'webm';
  formData.append('audio', blob, `recording.${ext}`);

  const res = await fetch('/api/stt', {
    method: 'POST',
    credentials: 'include', // httpOnly cookie auth
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof SyntaxError === false) throw e;
    }
    throw new Error(`Transcription failed ${res.status}`);
  }

  return res.json() as Promise<{ text: string }>;
}

// ---- Text-to-speech (voice-out) ----

export interface TtsStatus {
  enabled: boolean;
  voices: { id: string; label: string }[];
  defaultVoice: string;
}

/** TTS availability + the list of selectable voices + the default voice. */
export function fetchTtsStatus(): Promise<TtsStatus> {
  return request<TtsStatus>('/api/tts/status');
}

/** Synthesize speech for text; returns an object URL for an Audio element. */
export async function synthesizeSpeech(text: string, voice?: string, speed?: number): Promise<string> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed ${res.status}: ${body}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function shutdown(): Promise<void> {
  return request<void>('/api/health/shutdown', { method: 'POST' });
}

/** Triggers a server restart (exits with code 75 so the macOS app auto-relaunches). */
export function restartApp(): Promise<void> {
  return request<void>('/api/health/restart', { method: 'POST' });
}

// ---- Headroom compression proxy ----

export interface HeadroomStats {
  apiRequests: number;
  primaryModel: string;
  requestsCompressed: number;
  avgCompressionPct: number;
  totalTokensSaved: number;
  savedUsd: number;
  savingsPct: number;
}

export interface HeadroomStatus {
  enabled: boolean;
  ready: boolean;
  port: number;
  stats: HeadroomStats | null;
}

export function fetchHeadroomStatus(): Promise<HeadroomStatus> {
  return request<HeadroomStatus>('/api/headroom/stats');
}

export interface SettingsResponse {
  // Any registered provider id ("claude", "kimi", "openrouter", or a custom one).
  activeProvider: string | null;
}

export function fetchSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings');
}

export function setProvider(provider: string): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings/provider', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export interface ProviderModel {
  id: string;
  displayName: string;
  cheap?: boolean;
}

export interface ProviderSummary {
  id: string;
  displayName: string;
  anthropicCompatible: boolean;
  hasApiKey: boolean;
}

export function fetchProviders(): Promise<{ providers: ProviderSummary[] }> {
  return request<{ providers: ProviderSummary[] }>('/api/providers');
}

export function fetchProviderModels(providerId: string): Promise<{ providerId: string; models: ProviderModel[] }> {
  return request<{ providerId: string; models: ProviderModel[] }>(`/api/providers/${encodeURIComponent(providerId)}/models`);
}

export function logoutProvider(): Promise<{ success: boolean; settings: SettingsResponse }> {
  return request<{ success: boolean; settings: SettingsResponse }>('/api/settings/logout', {
    method: 'POST',
  });
}

// ---- OneNote Integration ----

export interface OneNoteStatus {
  status: 'disconnected' | 'pending' | 'connected' | 'error';
  hasClientId: boolean;
}

export interface OneNoteDeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
}

export function fetchOneNoteStatus(): Promise<OneNoteStatus> {
  return request<OneNoteStatus>('/api/onenote/auth/status');
}

export function setOneNoteClientId(clientId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/onenote/client-id', {
    method: 'PUT',
    body: JSON.stringify({ clientId }),
  });
}

export function startOneNoteAuth(): Promise<OneNoteDeviceCode> {
  return request<OneNoteDeviceCode>('/api/onenote/auth/start', { method: 'POST' });
}

export function disconnectOneNote(): Promise<{ ok: boolean; status: string }> {
  return request<{ ok: boolean; status: string }>('/api/onenote/auth', { method: 'DELETE' });
}

export function sendToOneNote(
  title: string,
  content: string,
  notebook?: string,
  section?: string
): Promise<{ ok: boolean; pageId: string; webUrl: string }> {
  return request<{ ok: boolean; pageId: string; webUrl: string }>('/api/onenote/send', {
    method: 'POST',
    body: JSON.stringify({ title, content, notebook, section }),
  });
}

// ---- Token Usage Dashboard ----

export interface SessionUsageBreakdown {
  title: string;
  costUsd: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SubagentUsageBreakdown {
  engine: string;
  model: string | null;
  parentSessionId: string;
  task: string;
  costUsd: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelUsageBreakdown {
  costUsd: number;
  messages: number;
  /** False when at least one entry in this bucket had unknown per-token pricing. */
  priceKnown: boolean;
}

export interface TokenUsagePeriod {
  period: 'day' | 'week' | 'month';
  from: string;
  to: string;
  totalCostUsd: number;
  totalMessages: number;
  totalDurationMs: number;
  bySession: Record<string, SessionUsageBreakdown>;
  bySubagent: Record<string, SubagentUsageBreakdown>;
  bySource: Record<string, { costUsd: number; messages: number }>;
  byModel: Record<string, ModelUsageBreakdown>;
}

export function fetchTokenUsage(period: 'day' | 'week' | 'month'): Promise<TokenUsagePeriod> {
  return request<TokenUsagePeriod>(`/api/token-usage?period=${period}`);
}

// ---- The Medusa layer: persona, rules, theme, voice, toolbox, packs ----

export interface Persona {
  name: string;
  greeting: string;
  personality: string;
  avatar: string | null;
}

export interface MedusaRule {
  name: string;
  content: string;
  enabled: boolean;
}

export interface MedusaTheme {
  mode: 'dark' | 'light';
  background: string;
  surface: string;
  accent: string;
  text: string;
  muted: string;
  danger: string;
  font: string;
  density: 'compact' | 'comfortable';
  avatar: string | null;
}

export interface MedusaVoice {
  engine: string;
  voiceId: string;
  speed: number;
  pitch: number;
  enabled: boolean;
  /**
   * S14-C additions for the speech-to-speech loop (spec section 4/6). The
   * server-side pack schema for these is not final until S14-A merges
   * (see docs/2026-09-18_s14_voice_loop_spec.md section 6), so every field
   * here is optional and the client tolerates their absence on GET and
   * simply round-trips whatever the server accepts on PUT.
   */
  /** Default voice mode a new chat opens with. */
  voiceMode?: 'off' | 'push-to-talk' | 'always-on';
  /** VAD energy threshold sensitivity, 0 (least sensitive) to 1 (most). */
  vadSensitivity?: number;
  /** Silence duration (ms) that ends an utterance server-side. */
  silenceTimeoutMs?: number;
  /** What barge-in does to the in-flight assistant turn. */
  interruptBehavior?: 'abort' | 'queue';
}

export type ToolScope = 'read' | 'write' | 'shell';

export interface ToolboxEntry {
  id: string;
  label: string;
  detail: string;
  enabled: boolean;
  scope: ToolScope;
}

export interface Toolbox {
  servers: ToolboxEntry[];
  skills: ToolboxEntry[];
}

export interface RegistryCandidate {
  id: string;
  kind: 'server' | 'skill';
  label: string;
  detail: string;
  suggestedScope: ToolScope;
  homepage: string;
}

export interface PackManifest {
  name: string;
  version: string;
  author: string;
  description: string;
  license: string;
}

export interface MedusaPack {
  formatVersion: number;
  manifest: PackManifest;
  persona: Persona;
  rules: MedusaRule[];
  theme: MedusaTheme;
  voice: MedusaVoice;
  toolbox: Toolbox;
}

export interface InstalledPack {
  id: string;
  manifest: PackManifest;
  ruleCount: number;
}

export function fetchPersona(): Promise<Persona> {
  return request<Persona>('/api/medusa/persona');
}

export function savePersona(persona: Persona): Promise<Persona> {
  return request<Persona>('/api/medusa/persona', {
    method: 'PUT',
    body: JSON.stringify(persona),
  });
}

export function resetPersona(): Promise<Persona> {
  return request<Persona>('/api/medusa/persona/reset', { method: 'POST' });
}

/** The composed system prompt an engine would receive, for the live preview. */
export function fetchPromptPreview(
  personality?: string,
  workingDir?: string,
): Promise<{ prompt: string }> {
  const params = new URLSearchParams();
  if (personality) params.set('persona', personality);
  if (workingDir) params.set('workingDir', workingDir);
  const qs = params.toString();
  return request<{ prompt: string }>(`/api/medusa/preview${qs ? `?${qs}` : ''}`);
}

export function fetchRules(): Promise<{ rules: MedusaRule[] }> {
  return request<{ rules: MedusaRule[] }>('/api/medusa/rules');
}

export function createRule(name: string, content: string): Promise<MedusaRule> {
  return request<MedusaRule>('/api/medusa/rules', {
    method: 'POST',
    body: JSON.stringify({ name, content }),
  });
}

export function setRuleEnabled(name: string, enabled: boolean): Promise<MedusaRule> {
  return request<MedusaRule>(`/api/medusa/rules/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export function deleteRule(name: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/medusa/rules/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function fetchTheme(): Promise<MedusaTheme> {
  return request<MedusaTheme>('/api/medusa/theme');
}

export function saveTheme(theme: MedusaTheme): Promise<MedusaTheme> {
  return request<MedusaTheme>('/api/medusa/theme', { method: 'PUT', body: JSON.stringify(theme) });
}

export function fetchVoiceSettings(): Promise<MedusaVoice> {
  return request<MedusaVoice>('/api/medusa/voice');
}

export function saveVoiceSettings(voice: MedusaVoice): Promise<MedusaVoice> {
  return request<MedusaVoice>('/api/medusa/voice', { method: 'PUT', body: JSON.stringify(voice) });
}

export function fetchToolbox(): Promise<Toolbox> {
  return request<Toolbox>('/api/medusa/toolbox');
}

export function saveToolbox(toolbox: Toolbox): Promise<Toolbox> {
  return request<Toolbox>('/api/medusa/toolbox', { method: 'PUT', body: JSON.stringify(toolbox) });
}

/** Registry search proposes candidates only; adding one is a separate click. */
export function searchRegistry(q: string): Promise<{ candidates: RegistryCandidate[] }> {
  return request<{ candidates: RegistryCandidate[] }>(
    `/api/medusa/registry?q=${encodeURIComponent(q)}`,
  );
}

export function fetchPacks(): Promise<{ packs: InstalledPack[] }> {
  return request<{ packs: InstalledPack[] }>('/api/packs');
}

export function exportPack(manifest: Partial<PackManifest>): Promise<MedusaPack> {
  return request<MedusaPack>('/api/packs/export', {
    method: 'POST',
    body: JSON.stringify(manifest),
  });
}

export function importPack(
  pack: unknown,
): Promise<{ ok: boolean; manifest: PackManifest; backup: string; packs: InstalledPack[] }> {
  return request('/api/packs/import', { method: 'POST', body: JSON.stringify(pack) });
}

export function applyPack(id: string): Promise<{ ok: boolean; manifest: PackManifest }> {
  return request(`/api/packs/${encodeURIComponent(id)}/apply`, { method: 'POST' });
}

export function removePack(id: string): Promise<{ ok: boolean; packs: InstalledPack[] }> {
  return request(`/api/packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
