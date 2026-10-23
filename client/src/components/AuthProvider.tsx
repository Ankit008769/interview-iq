import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type User } from '../lib/api';

interface AuthContextType {
  user: User | null; loading: boolean; setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthContextType | null>(null);
export function AuthProvider({ children }: {children: ReactNode}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    api<{ user: User }>('/auth/me').then(d => { if(live) setUser(d.user); }).catch(() => {}).finally(() => {if(live) setLoading(false);});
    return () => { live = false; };
  }, []);
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); } finally { setUser(null); } }
  return <AuthContext.Provider value={{user, loading, setUser, logout}}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
