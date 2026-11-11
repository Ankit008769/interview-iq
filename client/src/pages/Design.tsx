import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Code2, Network, PencilRuler } from 'lucide-react';
import { api, type DesignPromptSummary } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

// The coding lab and the system-design board share one place in the navigation.
export function LabTabs({ current }: { current: 'coding' | 'design' }) {
  return <nav className="lab-tabs" aria-label="Practice labs">
    <Link to="/coding" className={current === 'coding' ? 'active' : ''} aria-current={current === 'coding' ? 'page' : undefined}><Code2 size={15}/> Coding</Link>
    <Link to="/design" className={current === 'design' ? 'active' : ''} aria-current={current === 'design' ? 'page' : undefined}><Network size={15}/> System design</Link>
  </nav>;
}

const LEVELS = ['All levels', 'Beginner', 'Intermediate', 'Advanced'] as const;

// System-design board (roadmap C3): draw a design for a realistic problem, estimate its capacity, then answer
// "changing constraints" questions from the AI interviewer.
export function DesignList() {
  const [prompts, setPrompts] = useState<DesignPromptSummary[] | null>(null);
  const [error, setError] = useState(''); const [level, setLevel] = useState<typeof LEVELS[number]>('All levels');
  useEffect(() => { api<{ prompts: DesignPromptSummary[] }>('/design/prompts').then(d => setPrompts(d.prompts)).catch(e => setError(e.message)); }, []);
  const shown = useMemo(() => (prompts ?? []).filter(p => level === 'All levels' || p.difficulty === level), [prompts, level]);
  if (!prompts) return error ? <div className="alert error" role="alert">{error}</div> : <LoadingScreen/>;
  return <div className="page-enter coding-page design-page">
    <LabTabs current="design"/>
    <div className="page-heading"><div><span className="eyebrow"><PencilRuler size={14}/> SYSTEM DESIGN</span><h1>System design board</h1>
      <p>Draw the architecture for a real-world problem, estimate the load it must handle, then defend it as the interviewer changes the constraints.</p></div></div>
    <div className="coding-intro card">
      <div><Network size={18}/><p><b>Your diagram is read by the app:</b> labelled boxes become components and arrows become connections, so you see exactly what the interviewer sees.</p></div>
      <div><PencilRuler size={18}/><p><b>Capacity estimates are checked with arithmetic,</b> not AI: you see how far off each one is and the formula behind the reference.</p></div>
      <div><CheckCircle2 size={18}/><p><b>{prompts.filter(p => p.reviewed).length} of {prompts.length}</b> problems reviewed.</p></div>
    </div>
    <div className="coding-filters"><label className="field level-field">Difficulty<select value={level} onChange={e => setLevel(e.target.value as typeof LEVELS[number])}>{LEVELS.map(l => <option key={l}>{l}</option>)}</select></label></div>
    <div className="problem-grid">{shown.map(p => <Link key={p.id} to={`/design/${p.id}`} className="card problem-card">
      <div className="problem-card-head"><span className="kind-badge"><Network size={16}/> Design</span>{p.reviewed && <span className="solved-badge"><CheckCircle2 size={14}/> Reviewed</span>}</div>
      <h3>{p.title}</h3><p className="problem-topics">{p.summary}</p>
      <div className="problem-card-foot"><span className={`difficulty-chip ${p.difficulty.toLowerCase()}`}>{p.difficulty}</span><span>{p.sessions ? `${p.sessions} ${p.sessions === 1 ? 'attempt' : 'attempts'}` : 'Not attempted'}</span><ChevronRight size={16}/></div>
    </Link>)}</div>
  </div>;
}
