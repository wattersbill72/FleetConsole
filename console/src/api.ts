export interface Farm { id: string; name: string; description: string; time_zone: string; created_at: string; updated_at: string }
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
};
