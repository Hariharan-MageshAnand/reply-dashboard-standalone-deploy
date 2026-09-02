import type { ApiErrorBody } from '@reply/contracts';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

let tokenGetter: (() => Promise<string | null>) | null = null;

export function registerTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiClientError';
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const token = tokenGetter ? await tokenGetter() : null;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiClientError(res.status, (data as ApiErrorBody) ?? {
      code: 'internal_error',
      message: 'Request failed.',
    });
  }
  return data as T;
}
