import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, BrainCircuit, CalendarDays, ChevronRight, CircleCheck, Clock3, GraduationCap, Play, Sparkles, Target, TrendingUp, Zap } from 'lucide-react';
import { api, type Overview } from '../lib/api';
import { useAuth } from '../components/AuthProvider';
import { LoadingScreen } from '../components/Layout';
import { WhatsNew } from '../components/WhatsNew';

const tracks = [
  { icon: <BrainCircuit size={21}/>, title:'Technical interview', desc:'DSA, React, Node.js and databases', hue:'purple', type:'Technical', topic:'DSA' },
  { icon: <GraduationCap size={21}/>, title:'Behavioral interview', desc:'Leadership, teamwork and problem solving', hue:'blue', type:'Behavioral', topic:'Behavioral' },
  { icon: <Sparkles size={21}/>, title:'HR interview', desc:'Introduce yourself and career goals', hue:'mint', type:'HR', topic:'General' },
];
export function Dashboard() {
  const {user}=useAuth(); const [data,setData]=useState<Overview|null>(null); const [error,setError]=useState('');
  useEffect(()=>{api<Overview>('/interviews/dashboard').then(setData).catch(e=>setError(e.message));},[]);
  const date=new Intl.DateTimeFormat('en',{month:'long',day:'numeric',year:'numeric'}).format(new Date());
  return <div className="page-enter">
    <div className="page-kicker"><CalendarDays size={14}/> {date.toUpperCase()}</div>
    <div className="page-heading"><div><h1>Good to see you, {user?.name?.split(' ')[0]} <span className="wave">✦</span></h1><p>Build confidence, one conversation at a time.</p></div><Link to="/interview/new" className="button primary"><PlusIcon/> New interview <ArrowRight size={17}/></Link></div>
    <section className="hero"><div className="hero-copy"><span className="hero-tag"><Zap size={14}/> YOUR NEXT STEP STARTS HERE</span><h2>Practice smarter.<br/><span>Interview stronger.</span></h2><p>Walk into your next interview feeling prepared. Start a guided session tailored to your goals.</p><Link to="/interview/new" className="button light">Start practicing <ArrowUpRight size={17}/></Link></div><div className="hero-art"><div className="orb2 outer"/><div className="orb2 inner"/><div className="hero-avatar"><BrainCircuit size={52}/></div><div className="hero-floating top"><span className="signal"/> Interview in progress</div><div className="hero-floating bottom"><CircleCheck size={17}/> You're making progress!</div></div></section>
    <WhatsNew/>
    <div className="section-title"><div><h3>Your progress</h3><p>Track your interview preparation journey</p></div><span className="subtle-small">Updated after every session</span></div>
    {error&&<div className="alert error">{error}</div>}
    {!data ? !error&&<LoadingScreen/>:<div className="metrics">
      <Metric icon={<Target size={20}/>} hue="purple" label="Total sessions" value={data.total.toString()} note="Interviews started"/>
      <Metric icon={<CircleCheck size={20}/>} hue="mint" label="Completed" value={data.completed.toString()} note="Finished sessions"/>
      <Metric icon={<TrendingUp size={20}/>} hue="blue" label="Average AI score" value={data.averageScore===null?'—':`${data.averageScore}%`} note={data.averageScore===null?'Available with AI feedback':'From scored sessions'}/>
    </div>}
    <div className="section-title space-top"><div><h3>Choose your practice</h3><p>Pick a track and start a focused session</p></div></div>
    <div className="track-grid">{tracks.map(t=><Link to={`/interview/new?type=${encodeURIComponent(t.type)}&topic=${encodeURIComponent(t.topic)}`} key={t.title} className="track-card"><span className={`track-icon ${t.hue}`}>{t.icon}</span><h4>{t.title}</h4><p>{t.desc}</p><span className="track-link">Start session <ChevronRight size={16}/></span></Link>)}</div>
    <div className="section-title space-top"><div><h3>Recent interviews</h3><p>Your latest practice sessions</p></div><Link to="/history" className="text-link">View all <ArrowRight size={16}/></Link></div>
    <div className="card recent-card">{!data?.recent?.length?<div className="empty-state"><Clock3 size={25}/><h4>Nothing here yet</h4><p>Your sessions will appear here when you start practicing.</p><Link className="button secondary" to="/interview/new">Start your first interview <ArrowRight size={16}/></Link></div>:data.recent.map(item=><Link to={`/interview/${item._id}${item.status==='completed'?'/results':''}`} className="history-row" key={item._id}><div className="history-icon"><BrainCircuit size={20}/></div><div className="history-details"><b>{item.role}</b><span>{item.topic} · {item.type} · {new Date(item.createdAt).toLocaleDateString()}</span></div><span className={`status-chip ${item.status==='completed'?'complete':''}`}>{item.status==='completed'?'Completed':'In progress'}</span><ChevronRight size={17}/></Link>)}</div>
  </div>;
}
function PlusIcon(){return <Play size={15} fill="currentColor"/>}
function Metric({icon,hue,label,value,note}:{icon:React.ReactNode;hue:string;label:string;value:string;note:string}){return <div className="metric card"><div className={`metric-icon ${hue}`}>{icon}</div><span className="metric-label">{label}</span><div className="metric-value">{value}</div><span className="metric-note">{note}</span></div>}
