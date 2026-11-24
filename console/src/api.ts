export interface Farm { id: string; name: string; description: string; time_zone: string; created_at: string; updated_at: string }
export interface Enrolment { id: string; platform: 'ubuntu' | 'macos'; display_name: string | null; initial_config: Record<string, unknown>; created_at: string; expires_at: string }
export interface NodeRow { id: string; display_name: string; platform: 'ubuntu' | 'macos'; status: string; hostname: string | null; agent_version: string | null; last_heartbeat_at: string | null; enrolled_at: string }
export interface AlertRow {
  id: string; rule: string; subject_label: string; farm_name: string | null; opened_at: string; silent_since: string | null;
  closed_at: string | null; duration_s: number | null; outage_s: number | null; close_reason: string | null; detail: Record<string, unknown>;
}
export interface Target { id: string; channel: string; address: string; enabled: boolean }
export interface NotificationRow {
  id: string; kind: string; channel: string; recipient: string; status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number; last_error: string | null; created_at: string; sent_at: string | null; subject_label: string | null; rule: string | null;
}
export interface NotificationsView {
  channels: Record<string, { configured: boolean }>; targets: Target[]; recent: NotificationRow[]; failed_24h: number;
}
export interface Me { user: { id: string; username: string }; org: { id: string; name: string; productName: string } }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? 'Request failed');
  return body as T;
}

export const api = {
  branding: () => request<{ productName: string }>('/api/branding'),
  me: () => request<Me>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  farms: () => request<{ farms: Farm[] }>('/api/farms'),
  createFarm: (f: { name: string; description: string; time_zone: string }) =>
    request<{ farm: Farm }>('/api/farms', { method: 'POST', body: JSON.stringify(f) }),
  updateFarm: (id: string, f: Partial<{ name: string; description: string; time_zone: string }>) =>
    request<{ farm: Farm }>(`/api/farms/${id}`, { method: 'PATCH', body: JSON.stringify(f) }),
  alerts: (params: Record<string, string>) => request<{ alerts: AlertRow[]; total: number }>(`/api/alerts?${new URLSearchParams(params)}`),
  notifications: () => request<NotificationsView>('/api/notifications'),
  addTarget: (address: string) => request<{ target: Target }>('/api/notifications/targets', { method: 'POST', body: JSON.stringify({ channel: 'email', address }) }),
  deleteTarget: (id: string) => request<{ ok: true }>(`/api/notifications/targets/${id}`, { method: 'DELETE' }),
  testNotification: () => request<{ results: { recipient: string; ok: boolean; error?: string }[] }>('/api/notifications/test', { method: 'POST', body: '{}' }),
  retryNotifications: () => request<{ requeued: number }>('/api/notifications/retry', { method: 'POST', body: '{}' }),
  nodes: (farmId: string) => request<{ nodes: NodeRow[] }>(`/api/farms/${farmId}/nodes`),
  enrolments: (farmId: string) => request<{ enrolments: Enrolment[] }>(`/api/farms/${farmId}/enrolments`),
  createEnrolment: (farmId: string, body: { platform: 'ubuntu' | 'macos'; display_name?: string; intermittent: boolean; initial_config: Record<string, unknown> }) =>
    request<{ enrolment: Enrolment; token: string; command: string }>(`/api/farms/${farmId}/enrolments`, { method: 'POST', body: JSON.stringify(body) }),
  cancelEnrolment: (farmId: string, id: string) =>
    request<{ ok: true }>(`/api/farms/${farmId}/enrolments/${id}`, { method: 'DELETE' }),
};
