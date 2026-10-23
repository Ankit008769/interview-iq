import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BrainCircuit, CalendarDays, CircleCheck, Clock3, History as HistoryIcon, Plus } from 'lucide-react';
import { api, type Interview } from '../lib/api';
import { LoadingScreen } from '../components/Layout';
export function History(){const [items,setItems]=useState<Interview[]|null>(null);const[error,setError]=useState('');
  useEffect(()=>{api<{interviews:Interview[]}>('/interviews').then(d=>setItems(d.interviews)).catch(e=>setError(e.message));},[]);
  return <div className="page-enter"><div className="page-heading"><div><span className="eyebrow"><HistoryIcon size={15}/> YOUR JOURNEY</span><h1>Interview history</h1><p>Explore your previous sessions and review your progress.</p></div><Link className="button primary" to="/interview/new"><Plus size={17}/> New interview</Link></div>
    {error&&<div className="alert error">{error}</div>}{!items&&!error?<LoadingScreen/>:<div className="card recent-card history-list">{!items?.length?<div className="empty-state"><HistoryIcon size={27}/><h4>No interviews yet</h4><p>Start a session and it will appear here.</p><Link className="button primary" to="/interview/new">Start practicing <ArrowRight size={16}/></Link></div>:items.map(item=><Link key={item._id} to={`/interview/${item._id}${item.status==='completed'?'/results':''}`} className="history-row"><div className="history-icon"><BrainCircuit size={20}/></div><div className="history-details"><b>{item.role}</b><span><CalendarDays size={13}/> {new Date(item.createdAt).toLocaleDateString()} · {item.type} · {item.topic} · {item.difficulty}</span></div><span className={`status-chip ${item.status==='completed'?'complete':''}`}>{item.status==='completed'?<CircleCheck size={14}/>:<Clock3 size={14}/>} {item.status==='completed'?'Completed':'Continue'}</span>{item.feedback?.score!=null&&<b className="mini-score">{item.feedback.score}/100</b>}<ArrowRight size={17}/></Link>)}</div>}
  </div>;
}
