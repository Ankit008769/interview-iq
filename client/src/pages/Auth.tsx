import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, BrainCircuit, CheckCircle2, LockKeyhole, Sparkles } from 'lucide-react';
import { api, type User } from '../lib/api';
import { useAuth } from '../components/AuthProvider';

export function AuthPage({register = false}: {register?:boolean}) {
  const [name,setName]=useState(''); const [email,setEmail]=useState(''); const [password,setPassword]=useState('');
  const [loading,setLoading]=useState(false); const [error,setError]=useState('');
  const {setUser}=useAuth(); const navigate=useNavigate(); const location=useLocation();
  const from=(location.state as {from?:string}|null)?.from || '/dashboard';
  async function submit(e:FormEvent){e.preventDefault();setError('');setLoading(true);
    try {
      const d=await api<{user:User}>(register?'/auth/register':'/auth/login',{method:'POST',body:JSON.stringify(register?{name,email,password}:{email,password})});
      setUser(d.user);navigate(from,{replace:true});
    } catch(err){setError((err as Error).message);} finally {setLoading(false);}
  }
  return <div className="auth-layout"><section className="auth-brand-panel"><Link to="/login" className="brand"><span className="brand-symbol"><BrainCircuit size={23}/></span><span>interview<span className="brand-accent">IQ</span><small>AI INTERVIEW COACH</small></span></Link><div className="auth-art"><div className="orb orb-large"/><div className="orb orb-small"/><div className="auth-bubble bubble-a">Tell me about a challenge you solved...</div><div className="auth-bubble bubble-b"><Sparkles size={16}/> Great example. Here's a follow-up.</div></div><h1>Turn preparation<br/>into <span>confidence.</span></h1><p>Personalized practice sessions, adaptive questions and feedback that helps you grow.</p><div className="auth-benefits"><span><CheckCircle2 size={16}/> Realistic practice</span><span><CheckCircle2 size={16}/> Actionable feedback</span><span><CheckCircle2 size={16}/> Your progress, tracked</span></div></section>
  <section className="auth-form-panel"><div className="auth-form-wrap"><div className="auth-top"><span className="eyebrow"><Sparkles size={15}/> YOUR INTERVIEW ADVANTAGE</span><h2>{register?'Create your account':'Welcome back'}</h2><p>{register?'Start your interview preparation journey today.':'Sign in to pick up where you left off.'}</p></div><form onSubmit={submit} className="form-stack">
    {register&&<label className="field">Full name<input required minLength={2} maxLength={65} autoComplete="name" placeholder="Alex Morgan" value={name} onChange={e=>setName(e.target.value)}/></label>}
    <label className="field">Email address<input required type="email" autoComplete="email" placeholder="alex@example.com" value={email} onChange={e=>setEmail(e.target.value)}/></label>
    <label className="field">Password<input required type="password" minLength={8} autoComplete={register?'new-password':'current-password'} placeholder="At least 8 characters" value={password} onChange={e=>setPassword(e.target.value)}/></label>
    {error&&<div className="alert error" role="alert">{error}</div>}
    <button className="button primary full" disabled={loading} type="submit">{loading?'Working...':register?'Create account':'Sign in'} <ArrowRight size={17}/></button>
  </form><p className="auth-switch">{register?'Already have an account?':'New to InterviewIQ?'} <Link to={register?'/login':'/register'}>{register?'Sign in':'Create an account'}</Link></p><div className="privacy-note"><LockKeyhole size={15}/> Your answers are visible only in your own account.</div></div></section></div>;
}
