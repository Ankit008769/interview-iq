import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BrainCircuit, CalendarDays, CircleCheck, Clock3, History as HistoryIcon, Plus } from 'lucide-react';
import { api, type Interview } from '../lib/api';
import { LoadingScreen } from '../components/Layout';
interface HistoryPage { interviews: Interview[]; nextCursor: string | null }
export function History() {
  const [items, setItems] = useState<Interview[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setBusy(true); setError('');
    api<HistoryPage>('/interviews', {signal: controller.signal}).then(d => {
      if (live) { setItems(d.interviews); setCursor(d.nextCursor); }
    }).catch(err => { if (live) setError(err.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; controller.abort(); };
  }, [reload]);
  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true); setError('');
    try {
      const d = await api<HistoryPage>(`/interviews?cursor=${encodeURIComponent(cursor)}`);
      setItems(previous => {
        const ids = new Set(previous?.map(x => x._id));
        return [...(previous ?? []), ...d.interviews.filter(x => !ids.has(x._id))];
      });
      setCursor(d.nextCursor);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="page-enter"><div className="page-heading"><div><span className="eyebrow"><HistoryIcon size={15}/> YOUR JOURNEY</span><h1>Interview history</h1><p>Explore your previous sessions and review your progress.</p></div><Link className="button primary" to="/interview/new"><Plus size={17}/> New interview</Link></div>
    {error&&<div className="alert error" role="alert">{error}{!items&&<button className="button secondary" disabled={busy} onClick={()=>setReload(n=>n+1)}>Retry history</button>}</div>}{!items&&!error?<LoadingScreen/>:items&&<div className="card recent-card history-list">{!items?.length?<div className="empty-state"><HistoryIcon size={27}/><h4>No interviews yet</h4><p>Start a session and it will appear here.</p><Link className="button primary" to="/interview/new">Start practicing <ArrowRight size={16}/></Link></div>:items.map(item=><Link key={item._id} to={`/interview/${item._id}${item.status==='completed'?'/results':''}`} className="history-row"><div className="history-icon"><BrainCircuit size={20}/></div><div className="history-details"><b>{item.role}</b><span><CalendarDays size={13}/> {new Date(item.createdAt).toLocaleDateString()} · {item.purpose==='drill'?'Drill · ':''}{item.type} · {item.topic} · {item.difficulty}</span></div><span className={`status-chip ${item.status==='completed'?'complete':''}`}>{item.status==='completed'?<CircleCheck size={14}/>:<Clock3 size={14}/>} {item.status==='completed'?'Completed':'Continue'}</span>{item.feedback?.score!=null&&<b className="mini-score">{item.feedback.score}/100</b>}<ArrowRight size={17}/></Link>)}</div>}
    {cursor&&<button className="button secondary" disabled={busy} onClick={loadMore}>{busy?"Loading interviews...":error?"Retry loading more":"Load more interviews"}</button>}
  </div>;
}
