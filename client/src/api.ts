import type { SessionMeta } from './types/session';
import type { ChatMessage } from './types/message';
import type { HubMessage } from './types/hub';
import type { CompletedTask } from './types/task';
import type { ProjectSummary, Project } from './types/project';

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

export function shutdown(): Promise<void> {
  return request<void>('/api/health/shutdown', { method: 'POST' });
}

export interface AccountLoginStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

export interface AccountInfo {
  id: 1 | 2;
  name: string;
  configDir: string;
}

export interface SettingsResponse {
  activeAccount: 1 | 2;
  accounts: AccountInfo[];
}

export interface LoginStatusResponse extends SettingsResponse {
  loginStatuses: Record<number, AccountLoginStatus>;
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
