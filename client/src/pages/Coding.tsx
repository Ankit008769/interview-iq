import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LabTabs } from './Design';
import { Bug, CheckCircle2, ChevronRight, Code2, Database, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { api, type CodingProblemSummary, type CodingStatus } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

const KINDS = [{ id: 'all', label: 'All' }, { id: 'algorithm', label: 'Algorithms' }, { id: 'debugging', label: 'Debugging' }, { id: 'sql', label: 'SQL' }] as const;
const LEVELS = ['All levels', 'Beginner', 'Intermediate', 'Advanced'] as const;
const KIND_ICON = { algorithm: <Code2 size={16}/>, debugging: <Bug size={16}/>, sql: <Database size={16}/> };

// Coding lab (roadmap C2): curated problems whose code runs against hidden tests in a separate sandbox.
export function CodingList() {
  const [problems, setProblems] = useState<CodingProblemSummary[] | null>(null);
  const [status, setStatus] = useState<CodingStatus | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<typeof KINDS[number]['id']>('all');
  const [level, setLevel] = useState<typeof LEVELS[number]>('All levels');
  useEffect(() => {
    api<{ problems: CodingProblemSummary[] }>('/coding/problems').then(d => setProblems(d.problems)).catch(e => setError(e.message));
    api<CodingStatus>('/coding/status').then(setStatus).catch(() => {});
  }, []);
  const shown = useMemo(() => (problems ?? []).filter(p => (kind === 'all' || p.kind === kind) && (level === 'All levels' || p.difficulty === level)), [problems, kind, level]);
  if (!problems) return error ? <div className="alert error" role="alert">{error}</div> : <LoadingScreen/>;
  const solved = problems.filter(p => p.solved).length;
  return <div className="page-enter coding-page">
    <LabTabs current="coding"/>
    <div className="page-heading"><div><span className="eyebrow"><Code2 size={14}/> CODING LAB</span><h1>Coding lab</h1>
      <p>Write code in JavaScript, TypeScript, Python, Java or C++, run it against hidden tests, then explain your approach to the AI interviewer.</p></div></div>
    {status && !status.runner.ready && <div className="alert warning" role="status"><TriangleAlert size={16}/> {status.runner.configured ? 'The code runner is starting or unavailable right now. You can read problems and write code; running may take a moment or fail until it is back.' : 'Code running is not set up on this server, so problems can be read but not run.'}</div>}
    <div className="coding-intro card">
      <div><ShieldCheck size={18}/><p><b>Test results come from running your code</b>, in a separate sandbox with no network access. No AI decides whether your code passes.</p></div>
      <div><Sparkles size={18}/><p><b>After a submission</b>, the AI interviewer asks one follow-up question about your approach and complexity, then reviews your explanation and code.</p></div>
      <div><CheckCircle2 size={18}/><p><b>{solved} of {problems.length}</b> problems solved.</p></div>
    </div>
    <div className="coding-filters">
      <div className="segmented kind-select" role="group" aria-label="Problem type">{KINDS.map(k => <button key={k.id} type="button" aria-pressed={kind === k.id} className={kind === k.id ? 'active' : ''} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
      <label className="field level-field">Difficulty<select value={level} onChange={e => setLevel(e.target.value as typeof LEVELS[number])}>{LEVELS.map(l => <option key={l}>{l}</option>)}</select></label>
    </div>
    <div className="problem-grid">{shown.map(p => <Link key={p.id} to={`/coding/${p.id}`} className="card problem-card">
      <div className="problem-card-head"><span className={`kind-badge ${p.kind}`}>{KIND_ICON[p.kind]} {p.kind === 'sql' ? 'SQL' : p.kind === 'debugging' ? 'Debugging' : 'Algorithm'}</span>{p.solved && <span className="solved-badge"><CheckCircle2 size={14}/> Solved</span>}</div>
      <h3>{p.title}</h3>
      <p className="problem-topics">{p.topics.join(' · ')}</p>
      <div className="problem-card-foot"><span className={`difficulty-chip ${p.difficulty.toLowerCase()}`}>{p.difficulty}</span><span>{p.submissions ? `${p.submissions} ${p.submissions === 1 ? 'submission' : 'submissions'}` : 'Not attempted'}</span><ChevronRight size={16}/></div>
    </Link>)}</div>
    {!shown.length && <p className="empty-note">No problems match these filters.</p>}
  </div>;
}
