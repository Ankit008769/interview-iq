import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type User } from '../lib/api';

interface AuthContextType {
  user: User | null; loading: boolean; setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  error: string; retry: () => void;
}
const AuthContext = createContext<AuthContextType | null>(null);
export function AuthProvider({ children }: {children: ReactNode}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setLoading(true); setError('');
    api<{user: User}>('/auth/me', {signal: controller.signal}).then(d => { if(live) setUser(d.user); })
      .catch(err => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setError('We could not load your account. Check your connection and try again.');
      }).finally(() => { if(live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [attempt]);
  const retry = () => { setLoading(true); setError(''); setAttempt(n => n + 1); };
  async function logout() { await api('/auth/logout', { method: 'POST' }); setUser(null); }
  return <AuthContext.Provider value={{user, loading, error, retry, setUser, logout}}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
export function AccountLoadError() {
  const {error, retry} = useAuth();
  return <div className="card padding-card" role="alert"><h1>Account unavailable</h1><p>{error}</p>
    <button className="button primary" onClick={retry}>Retry loading account</button></div>;
}
