const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5050/api/v1';

interface ApiOptions extends RequestInit {
  body?: string;
}

class ApiClient {
  private token: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) localStorage.setItem('auth_token', token);
    else localStorage.removeItem('auth_token');
  }

  getToken(): string | null {
    if (!this.token) this.token = localStorage.getItem('auth_token');
    return this.token;
  }

  private async tryRefresh(): Promise<boolean> {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      this.setToken(data.token);
      if (data.refreshToken) localStorage.setItem('refresh_token', data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  async fetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (res.status === 401) {
      // Try silent refresh (deduplicated — only one refresh at a time)
      if (!this.refreshing) {
        this.refreshing = this.tryRefresh().finally(() => { this.refreshing = null; });
      }
      const refreshed = await this.refreshing;

      if (refreshed) {
        // Retry the original request with the new token
        headers['Authorization'] = `Bearer ${this.getToken()}`;
        const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (retry.ok) return retry.json();
        // Only force logout if retry also gets auth error
        if (retry.status !== 401 && retry.status !== 403) {
          const err = await retry.json().catch(() => ({ detail: 'Request failed' }));
          throw new Error(err.detail || err.error || `HTTP ${retry.status}`);
        }
      }

      // Refresh failed — clear tokens and redirect
      this.setToken(null);
      localStorage.removeItem('refresh_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  get<T>(path: string) { return this.fetch<T>(path); }

  post<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
