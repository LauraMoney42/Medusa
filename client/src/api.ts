import type { SessionMeta } from './types/session';
import type { ChatMessage } from './types/message';
import type { HubMessage } from './types/hub';
import type { CompletedTask } from './types/task';
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
 * Checks whether the current cookie is valid.
 * If not, attempts auto-login using the token injected into localStorage
 * by the macOS app (WebViewController).
 * Returns true if authenticated, false otherwise.
 */
export async function checkAuth(): Promise<boolean> {
  try {
    await request<{ ok: boolean }>('/api/auth/me');
    return true;
  } catch {
    // Cookie missing or invalid — try the token the macOS app injects
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

export function createSession(
  name: string,
  workingDir?: string,
  systemPrompt?: string,
): Promise<SessionMeta> {
  return request<SessionMeta>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name, workingDir, systemPrompt }),
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

export function fetchHubMessages(): Promise<HubMessage[]> {
  return request<HubMessage[]>('/api/hub');
}

export function fetchTasks(): Promise<CompletedTask[]> {
  return request<CompletedTask[]>('/api/hub/tasks');
}

export function acknowledgeTasks(): Promise<void> {
  return request<void>('/api/hub/tasks/ack', { method: 'POST' });
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

export function shutdown(): Promise<void> {
  return request<void>('/api/health/shutdown', { method: 'POST' });
}

/** Triggers a server restart (exits with code 75 so the macOS app auto-relaunches). */
export function restartApp(): Promise<void> {
  return request<void>('/api/health/restart', { method: 'POST' });
}

export interface AccountLoginStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

export interface KimiLoginStatus {
  loggedIn: boolean;
  email?: string;
}

export interface AccountInfo {
  id: 1 | 2;
  name: string;
  configDir: string;
}

export interface SettingsResponse {
  activeAccount: 1 | 2;
  activeProvider: 'claude' | 'kimi';
  llmProvider: 'claude' | 'openai' | 'kimi';
  llmApiKey: string;
  accounts: AccountInfo[];
  hasMicrosoftClientId?: boolean;
  oneNoteConnected?: boolean;
  kimiLoginStatus: KimiLoginStatus;
}

export interface LoginStatusResponse extends SettingsResponse {
  loginStatuses: Record<number, AccountLoginStatus>;
  kimiLoginStatus: KimiLoginStatus;
}

export function fetchSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings');
}

export function fetchLoginStatus(): Promise<LoginStatusResponse> {
  return request<LoginStatusResponse>('/api/settings/login-status');
}

export function setAccount(account: 1 | 2): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings/account', {
    method: 'POST',
    body: JSON.stringify({ account }),
  });
}

export function setProvider(provider: 'claude' | 'kimi'): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings/provider', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export function loginClaudeAccount(accountId: 1 | 2): Promise<{ success: boolean; loginStatus: AccountLoginStatus }> {
  return request<{ success: boolean; loginStatus: AccountLoginStatus }>(`/api/settings/account/${accountId}/login`, {
    method: 'POST',
  });
}

export function logoutClaudeAccount(accountId: 1 | 2): Promise<{ success: boolean; loginStatus: AccountLoginStatus }> {
  return request<{ success: boolean; loginStatus: AccountLoginStatus }>(`/api/settings/account/${accountId}/logout`, {
    method: 'POST',
  });
}

export function loginKimiAccount(): Promise<{ success: boolean; loginStatus: KimiLoginStatus }> {
  return request<{ success: boolean; loginStatus: KimiLoginStatus }>('/api/settings/kimi/login', {
    method: 'POST',
  });
}

export function logoutKimiAccount(): Promise<{ success: boolean; loginStatus: KimiLoginStatus }> {
  return request<{ success: boolean; loginStatus: KimiLoginStatus }>('/api/settings/kimi/logout', {
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

export interface TokenUsagePeriod {
  period: 'day' | 'week' | 'month';
  from: string;
  to: string;
  totalCostUsd: number;
  totalMessages: number;
  totalDurationMs: number;
  byBot: Record<string, { costUsd: number; messages: number }>;
  bySource: Record<string, { costUsd: number; messages: number }>;
}

export function fetchTokenUsage(period: 'day' | 'week' | 'month'): Promise<TokenUsagePeriod> {
  return request<TokenUsagePeriod>(`/api/token-usage?period=${period}`);
}

export type ComparePeriod = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export interface ComparePeriodSummary {
  label: string;
  from: string;
  to: string;
  totalCostUsd: number;
  totalMessages: number;
  byBot: Record<string, { costUsd: number; messages: number }>;
}

export interface CompareResult {
  a: ComparePeriodSummary;
  b: ComparePeriodSummary;
}

export function fetchCompare(a: ComparePeriod, b: ComparePeriod): Promise<CompareResult> {
  return request<CompareResult>(`/api/metrics/compare?a=${a}&b=${b}`);
}
