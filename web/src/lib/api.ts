import type { Session, ChatMessage, TodoItem } from '../types';

const getBaseUrl = () => {
  const stored = localStorage.getItem('copilot-remote-server');
  return stored || '';
};

const getToken = () => localStorage.getItem('copilot-remote-token') || '';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const base = getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),

  listSessions: () => request<Session[]>('/api/sessions'),

  getSession: (id: string) => request<Session & { messages: ChatMessage[] }>(`/api/sessions/${id}`),

  createSession: (opts: { prompt?: string; cwd?: string; resume?: string }) =>
    request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(opts) }),

  sendMessage: (id: string, text: string) =>
    request<{ sent: boolean }>(`/api/sessions/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) }),

  killSession: (id: string) =>
    request<{ killed: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  purgeSession: (id: string) =>
    request<{ deleted: boolean }>(`/api/sessions/${id}/purge`, { method: 'DELETE' }),

  updateSessionMeta: (id: string, meta: { name?: string; tags?: string[] }) =>
    request<{ name?: string; tags?: string[] }>(`/api/sessions/${id}/meta`, { method: 'PATCH', body: JSON.stringify(meta) }),

  addTag: (id: string, tag: string) =>
    request<{ tags: string[] }>(`/api/sessions/${id}/tags`, { method: 'POST', body: JSON.stringify({ tag }) }),

  removeTag: (id: string, tag: string) =>
    request<{ tags: string[] }>(`/api/sessions/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  getTodos: () =>
    request<{ items: TodoItem[]; todoMode: boolean }>('/api/todos'),

  saveTodos: (items: TodoItem[], todoMode: boolean) =>
    request<{ ok: boolean }>('/api/todos', { method: 'PUT', body: JSON.stringify({ items, todoMode }) }),
};
