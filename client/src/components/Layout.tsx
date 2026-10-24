import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BrainCircuit, History, LayoutDashboard, LogOut, PlusCircle, Sparkles, UserRound } from 'lucide-react';
import { useAuth } from './AuthProvider';
const nav = [
  { to: '/dashboard', label: 'Overview', Icon: LayoutDashboard },
  { to: '/interview/new', label: 'New interview', Icon: PlusCircle },
  { to: '/account', label: 'Account', Icon: UserRound },
  { to: '/history', label: 'My interviews', Icon: History },
];
export function Layout() {
  const { user, logout } = useAuth(); const navigate = useNavigate();
  const [logoutError, setLogoutError] = useState('');
  async function onLogout() {
    setLogoutError('');
    try { await logout(); navigate('/login'); }
    catch { setLogoutError('Sign out failed. Please check your connection and try again.'); }
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" to="/dashboard"><span className="brand-symbol"><BrainCircuit size={23}/></span><span>interview<span className="brand-accent">IQ</span><small>AI INTERVIEW COACH</small></span></Link>
      <div className="sidebar-section">WORKSPACE</div>
      <nav className="navlist">{nav.map(({to,label,Icon})=><NavLink key={to} to={to} className={({isActive})=>`navitem ${isActive ? 'active':''}`}><Icon size={18}/><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-spacer"/>
      {logoutError && <div className="alert error" role="alert">{logoutError}</div>}
      <div className="tip-card"><span className="tip-icon"><Sparkles size={19}/></span><b>Practice with purpose</b><p>A little progress in every session adds up to real confidence.</p><Link to="/interview/new">Start a session <ArrowUpRight size={15}/></Link></div>
      <div className="side-user"><div className="avatar">{user?.name?.charAt(0)?.toUpperCase() || <UserRound size={18}/>}</div><div className="user-meta"><b>{user?.name}</b><span>{user?.email}</span></div><button className="icon-button" onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={17}/></button></div>
    </aside>
    <main className="workspace"><header className="topbar"><div className="mobile-brand"><BrainCircuit size={19}/> interviewIQ</div><span className="topbar-message">Your preparation space <span className="dot"/></span><div className="topbar-right"><span className="pill muted-pill"><Sparkles size={14}/> Portfolio MVP</span><div className="avatar small">{user?.name?.charAt(0)?.toUpperCase()}</div></div></header><div className="content"><Outlet/></div></main>
    <nav className="mobile-nav">{nav.map(({to,label,Icon})=><NavLink key={to} to={to} className={({isActive})=>`mobile-navitem ${isActive?'active':''}`}><Icon size={19}/><span>{label}</span></NavLink>)}</nav>
  </div>;
}
export function LoadingScreen(){return <div className="screen-loading"><span className="loader"/> Loading InterviewIQ...</div>}
