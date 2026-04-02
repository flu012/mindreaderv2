import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import GraphApp from '../components/GraphApp';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [usage, setUsage] = useState<any>(null);

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    api.get('/usage').then(setUsage).catch(() => {});
  }, [user, navigate]);

  // Inject auth header into all /api/* fetch calls (for MindReader graph components)
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      if (url.startsWith('/api/')) {
        const token = localStorage.getItem('auth_token');
        if (token) {
          const headers = new Headers(init.headers || {});
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`);
          }
          init = { ...init, headers };
        }
      }
      return originalFetch(input, init);
    };
    return () => { window.fetch = originalFetch; };
  }, []);

  if (!user) return null;

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a14', color: '#e0e0e8' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, zIndex: 200, position: 'relative' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700 }}>
          <span style={{ background: 'linear-gradient(135deg, #4aff9e, #4a9eff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>MindReader</span>
          <span style={{ color: '#666', fontWeight: 400 }}> Cloud</span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {usage && (
            <div style={{ fontSize: 11, color: '#8888aa' }}>
              Entities: {usage.entityCount}/{usage.maxEntities === -1 ? '\u221E' : usage.maxEntities} |
              Evolves today: {usage.evolvesToday}/{usage.maxEvolvesPerDay === -1 ? '\u221E' : usage.maxEvolvesPerDay}
            </div>
          )}
          <span style={{ fontSize: 12, color: '#8888aa' }}>{user.email || user.name}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', background: '#4aff9e22', color: '#4aff9e', borderRadius: 4 }}>{user.tier}</span>
          <button onClick={logout} style={{ padding: '4px 12px', background: 'rgba(255,255,255,0.06)', color: '#8888aa', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Sign Out</button>
        </div>
      </div>

      {/* Embedded MindReader UI */}
      <div style={{ height: 'calc(100vh - 52px)', overflow: 'hidden' }}>
        <GraphApp />
      </div>
    </div>
  );
}
