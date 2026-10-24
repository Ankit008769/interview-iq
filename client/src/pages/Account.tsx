import { AIConsent } from '../components/AIConsent';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../components/AuthProvider';
interface Session { id: string; createdAt: string; expiresAt: string; current: boolean }
interface Usage { rows: { _id: string; attempts: number; inputTokens: number; outputTokens: number; unknownUsage: number }[]; note: string }
export function Account() {
  const { user, setUser } = useAuth(); const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]); const [usage, setUsage] = useState<Usage>();
  const [emailEnabled, setEmailEnabled] = useState(false); const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  async function load() {
    setError('');
    try { const [s, u, c] = await Promise.all([api<{sessions:Session[]}>('/account/sessions'), api<Usage>('/account/usage'), api<{emailDelivery:boolean}>('/auth/capabilities')]);
      setSessions(s.sessions); setUsage(u); setEmailEnabled(c.emailDelivery); setLoaded(true);
    } catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  async function action(path: string, body?: unknown, signOut = false, method = 'POST') {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api<{message?:string}>(path, { method, ...(body ? {body:JSON.stringify(body)} : {}) });
      if (signOut) { setUser(null); navigate('/login', {replace:true}); }
      else { setMessage(result.message || 'Done.'); await load(); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <div className="account-page"><h1>Account & privacy</h1><p>Manage access, your saved data and AI usage.</p>
    {error && <div className="alert error" role="alert">{error} <button className="button" onClick={load}>Retry loading</button></div>}
    {message && <p role="status">{message}</p>}
    {!loaded ? <p>Loading account settings…</p> : <>
    <section className="account-card"><AIConsent/></section>
    <section className="account-card"><h2>Email verification</h2><p>{user?.email} · {user?.emailVerified ? 'Verified' : 'Not verified'}</p>
      {!emailEnabled && <p>Email delivery is not configured yet. Recovery and verification emails are unavailable.</p>}
      <button className="button" disabled={busy || !emailEnabled || user?.emailVerified} onClick={() => action('/auth/verification-email')}>Send verification email</button></section>
    <section className="account-card"><h2>Active sessions</h2><p>Sessions expire after seven days. Password changes sign out every session.</p>
      <ul className="session-list">{sessions.map(s => <li key={s.id}><span>{s.current ? 'This session' : 'Other session'} · Started {new Date(s.createdAt).toLocaleString()}</span><button className="button" disabled={busy} onClick={() => action(`/account/sessions/${s.id}`, undefined, s.current, 'DELETE')}>Revoke {s.current ? 'this session' : 'session'}</button></li>)}</ul>
      <button className="button" disabled={busy} onClick={() => action('/account/revoke-all', undefined, true)}>Sign out all sessions</button></section>
    <section className="account-card"><h2>Change password</h2><form className="form-stack" onSubmit={(e:FormEvent) => { e.preventDefault(); void action('/account/password', {currentPassword,newPassword},true); }}>
      <label className="field">Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label>
      <label className="field">New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label>
      <p>Use at least 8 characters, at most 72 UTF-8 bytes.</p><button className="button primary" disabled={busy}>Change password and sign out</button></form></section>
    <section className="account-card"><h2>AI usage · last 30 days</h2><p>{usage?.note}</p>
      {!usage?.rows.length ? <p>No AI attempts recorded.</p> : <ul>{usage.rows.map(row=><li key={row._id}>{row._id === 'started' ? 'Unresolved' : row._id}: {row.attempts} attempts · {row.inputTokens} reported input tokens · {row.outputTokens} reported output tokens · {row.unknownUsage} with unknown usage</li>)}</ul>}</section>
    <section className="account-card"><h2>Export your data</h2><p>Download your profile, saved interviews and usage records as JSON.</p><a className="button" href="/api/account/export">Download my data</a></section>
    <section className="account-card"><h2>Delete account</h2><p>Deletion revokes access immediately. Background cleanup removes your profile, interviews, usage and sessions. Backup copies expire separately; minimal deletion receipts are retained separately to prevent restoration of deleted accounts. Cleanup waits if that safety copy is temporarily unavailable.</p>
      <form className="form-stack" onSubmit={e=>{e.preventDefault(); void action('/account/delete',{password:deletePassword,confirmation},true);}}>
      <label className="field">Password to delete account<input type="password" autoComplete="current-password" required value={deletePassword} onChange={e=>setDeletePassword(e.target.value)}/></label>
      <label className="field">Type DELETE<input required pattern="DELETE" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
      <button className="button" disabled={busy || confirmation !== 'DELETE'}>Permanently delete account</button></form></section></>}
  </div>;
}
export function AccountRecovery({ verify = false }: {verify?:boolean}) {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [email,setEmail] = useState(''); const [password,setPassword] = useState('');
  const [message,setMessage] = useState(''); const [error,setError] = useState(''); const [busy,setBusy] = useState(false); const [done,setDone] = useState(false);
  const {setUser} = useAuth();
  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);
  async function submit(e:FormEvent) {
    e.preventDefault(); setBusy(true);setError('');
    try {
      const result = await api<{message?:string}>(verify ? '/auth/verify-email' : token ? '/auth/reset-password' : '/auth/forgot-password', {method:'POST',body:JSON.stringify(verify ? {token} : token ? {token,password} : {email})});
      setMessage(result.message || (verify ? 'Email verified. Reload your account page to see the updated status.' : 'Password reset. Sign in with your new password.'));
      if (!verify && token) setUser(null); setDone(true);
    } catch(err) {setError((err as Error).message);} finally {setBusy(false);}
  }
  return <main className="recovery-page account-card"><h1>{verify ? 'Verify email' : token ? 'Reset password' : 'Recover account'}</h1>
    {!token && !verify && <p>Email delivery is not configured yet. Recovery requests are unavailable until the site owner enables delivery.</p>}
    {error && <div className="alert error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    {!done && <form className="form-stack" onSubmit={submit}>
      {!verify && (token ? <label className="field">New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={password} onChange={e=>setPassword(e.target.value)}/></label> : <label className="field">Email address<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label>)}
      <button className="button primary" disabled={busy || (verify && !token)}>{verify ? 'Verify email' : token ? 'Reset password' : 'Request recovery link'}</button></form>}
    <p><Link to="/login">Back to sign in</Link></p></main>;
}
