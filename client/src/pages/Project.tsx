import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleHelp, Code2, FileSearch, ShieldAlert, XCircle } from 'lucide-react';
import { api, warmUpAI, type CandidateDocument, type ClaimCheck, type CodeSymbol, type Interview, type ProjectDetail } from '../lib/api';
import { AIConsent } from '../components/AIConsent';
import { LoadingScreen } from '../components/Layout';
import { secretSummary } from '../components/Projects';

const STATUS = { supported: { label: 'Found in the code', Icon: CheckCircle2 }, partial: { label: 'Partly found', Icon: CircleHelp }, not_found: { label: 'Not found in the code', Icon: XCircle } };

// One uploaded project (roadmap C4): what was indexed, what was removed, a project-defense interview and a
// check of resume claims against the code.
export function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState('');
  const [resumes, setResumes] = useState<CandidateDocument[]>([]);
  const [consented, setConsented] = useState<boolean | null>(null); const [aiAvailable, setAIAvailable] = useState(false);
  useEffect(() => {
    api<{ project: ProjectDetail }>(`/projects/${id}`).then(d => setProject(d.project)).catch(e => setError(e.message));
    api<{ documents: CandidateDocument[] }>('/documents').then(d => setResumes(d.documents.filter(x => x.kind === 'resume' && !x.deleting))).catch(() => {});
    api<{ accepted: boolean; disclosure: unknown }>('/account/ai-consent').then(c => { setConsented(c.accepted); setAIAvailable(!!c.disclosure); if (c.disclosure) warmUpAI(); }).catch(() => {});
  }, [id]);
  if (!project) return error ? <div className="alert error" role="alert">{error} <Link to="/documents">Back to your projects</Link></div> : <LoadingScreen/>;
  const removed = secretSummary(project);
  return <div className="page-enter project-page">
    <Link to="/documents" className="back-link"><ArrowLeft size={16}/> Resume & code</Link>
    <div className="page-heading"><div><span className="eyebrow"><Code2 size={14}/> PROJECT DEFENSE</span><h1>{project.name}</h1>
      <p>{project.stats.files} files · {project.stats.lines.toLocaleString()} lines · {project.stats.symbols} functions, classes and routes · {project.stats.languages.map(l => `${l.language} (${l.files})`).join(', ')}</p></div></div>
    {removed > 0 && <section className="alert warning secrets-panel" aria-label="Secrets removed"><ShieldAlert size={18}/><div>
      <b>{removed} secret{removed === 1 ? ' was' : 's were'} removed before saving.</b> They were in the zip you uploaded, so treat them as exposed and rotate them.
      <ul>{project.secretFiles.map(f => <li key={f}><code>{f}</code>: file not saved</li>)}
        {project.secrets.map((s, i) => <li key={i}><code>{s.path}</code> line {s.line}: {s.kind} removed</li>)}</ul></div></section>}
    <div className="project-grid">
      <DefenseCard project={project} aiAvailable={aiAvailable} consented={consented} onConsent={setConsented} onStarted={i => navigate(`/interview/${i._id}`)}/>
      <ClaimsCard project={project} resumes={resumes} aiAvailable={aiAvailable} consented={consented} onChecked={setProject}/>
    </div>
    <CodeIndex project={project}/>
    <p className="project-foot">Skipped: {project.skipped.ignoredFolder} in dependency or build folders, {project.skipped.binaryOrOther} binary or non-source, {project.skipped.tooLarge} too large{project.skipped.overLimit ? `, ${project.skipped.overLimit} over the size limit` : ''}. Uploaded code is never run.</p>
  </div>;
}

function DefenseCard({ project, aiAvailable, consented, onConsent, onStarted }: { project: ProjectDetail; aiAvailable: boolean; consented: boolean | null; onConsent: (ready: boolean) => void; onStarted: (i: Interview) => void }) {
  const [role, setRole] = useState('Software Development Engineer');
  const [difficulty, setDifficulty] = useState<'Beginner' | 'Intermediate' | 'Advanced'>('Intermediate');
  const [count, setCount] = useState(3); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function start() {
    setBusy(true); setError('');
    try {
      const d = await api<{ interview: Interview }>('/interviews', { method: 'POST', timeoutMs: 180_000,
        body: JSON.stringify({ mode: 'ai', role, type: 'Technical', difficulty, topic: `Project: ${project.name}`.slice(0, 100), totalQuestions: count, projectId: project.id }) });
      onStarted(d.interview);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <section className="card defense-card" aria-label="Project defense interview"><h2>Defend this project</h2>
    <p>The interviewer picks a different function, class or route from your code for each question and asks why it works the way it does. The code is shown with each question; scoring checks your explanation against it.</p>
    {!aiAvailable ? <p>Project defense needs AI, which is not enabled on this server.</p> : <>
      <label className="field">Target role<input value={role} onChange={e => setRole(e.target.value)} maxLength={100}/></label>
      <div className="segmented" role="group" aria-label="Difficulty">{(['Beginner', 'Intermediate', 'Advanced'] as const).map(d => <button type="button" key={d} aria-pressed={difficulty === d} className={difficulty === d ? 'active' : ''} onClick={() => setDifficulty(d)}>{d}</button>)}</div>
      <div className="segmented count-select" role="group" aria-label="Questions">{[3, 5].map(n => <button type="button" key={n} aria-pressed={count === n} className={count === n ? 'active' : ''} onClick={() => setCount(n)}>{n} questions</button>)}</div>
      {consented === false && <AIConsent onChange={ready => onConsent(ready)}/>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="button" className="button primary" disabled={busy || consented !== true || role.trim().length < 2} onClick={() => void start()}>{busy ? 'Reading your code and writing the first question…' : 'Start project defense'} <ArrowRight size={16}/></button>
    </>}
  </section>;
}

function ClaimsCard({ project, resumes, aiAvailable, consented, onChecked }: { project: ProjectDetail; resumes: CandidateDocument[]; aiAvailable: boolean; consented: boolean | null; onChecked: (p: ProjectDetail) => void }) {
  const [documentId, setDocumentId] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!documentId && resumes[0]) setDocumentId(resumes[0].id); }, [resumes, documentId]);
  async function check() {
    setBusy(true); setError('');
    try { const d = await api<{ project: ProjectDetail }>(`/projects/${project.id}/claims`, { method: 'POST', body: JSON.stringify({ documentId }), timeoutMs: 300_000 }); onChecked(d.project); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const latest: ClaimCheck | undefined = project.claimChecks[0];
  return <section className="card claims-card" aria-label="Resume claims"><h2><FileSearch size={18}/> Resume claims vs. code</h2>
    <p>The AI lists what your resume claims about software you built; the app then looks for each claim in this project's dependencies, functions, files and code. Interviewers ask about claims they cannot see in your code.</p>
    {!aiAvailable ? <p>Checking claims needs AI, which is not enabled on this server.</p> : !resumes.length ? <p><Link to="/documents">Add your resume</Link> first.</p> : <>
      <label className="field">Resume<select value={documentId} onChange={e => setDocumentId(e.target.value)}>{resumes.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="button" className="button secondary" disabled={busy || !documentId || consented !== true} onClick={() => void check()}>{busy ? 'Reading your resume…' : 'Check claims against this code'}</button>
      {consented === false && <p className="timing-note">Accept AI processing in the card beside this one first.</p>}
    </>}
    {latest && <div className="claims-result"><p className="timing-note">From “{latest.documentTitle}”, {new Date(latest.createdAt).toLocaleString()}{latest.dropped ? `. ${latest.dropped} claim${latest.dropped === 1 ? ' was' : 's were'} dropped because the AI did not quote your resume exactly.` : '.'}</p>
      {!latest.claims.length ? <p>No claims about this kind of project were found in that resume.</p> : <ul className="claim-list">{latest.claims.map((c, i) => { const s = STATUS[c.status];
        return <li key={i} className={`claim ${c.status}`}><p className="claim-head"><s.Icon size={16}/> <b>{s.label}</b></p><blockquote>{c.quote}</blockquote>
          <p className="claim-keywords">Looked for: {c.keywords.join(', ')}</p>
          {c.evidence.length > 0 && <ul className="claim-evidence">{c.evidence.map((e, j) => <li key={j}><code>{e.path}{e.line ? `:${e.line}` : ''}</code> <span>{e.kind === 'dependency' ? 'dependency' : e.kind === 'symbol' ? 'code' : e.kind === 'file' ? 'file name' : 'text'}: {e.text}</span></li>)}</ul>}
        </li>; })}</ul>}
    </div>}
  </section>;
}

function CodeIndex({ project }: { project: ProjectDetail }) {
  const [query, setQuery] = useState(''); const [shown, setShown] = useState<{ symbol: CodeSymbol; text: string } | null>(null); const [error, setError] = useState('');
  const symbols = useMemo(() => {
    const q = query.trim().toLowerCase();
    return project.symbols.filter(s => !q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q)).slice(0, 150);
  }, [project.symbols, query]);
  async function open(symbol: CodeSymbol) {
    setError('');
    try {
      const d = await api<{ excerpt: { text: string } }>(`/projects/${project.id}/excerpt?path=${encodeURIComponent(symbol.path)}&start=${symbol.line}&end=${Math.max(symbol.endLine, symbol.line + (symbol.kind === 'route' ? 20 : 0))}`);
      setShown({ symbol, text: d.excerpt.text });
    } catch (e) { setError((e as Error).message); }
  }
  return <section className="card code-index" aria-label="Code index"><h2>What was indexed</h2>
    {project.dependencies.length > 0 && <p className="dependency-list"><b>Dependencies:</b> {project.dependencies.slice(0, 40).map(d => d.name).join(', ')}{project.dependencies.length > 40 ? ` and ${project.dependencies.length - 40} more` : ''}</p>}
    <label className="field">Search functions, classes and routes<input value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. login or src/routes"/></label>
    {error && <div className="alert error" role="alert">{error}</div>}
    <div className="symbol-layout">
      <ul className="symbol-list">{symbols.map((s, i) => <li key={i}><button type="button" className="link-button" onClick={() => void open(s)}>
        <span className={`symbol-kind ${s.kind}`}>{s.kind}</span> <b>{s.name}</b> <span className="symbol-path">{s.path}:{s.line}</span></button></li>)}
        {!symbols.length && <li className="empty-rows">Nothing matches.</li>}</ul>
      {shown && <div className="symbol-code"><p><code>{shown.symbol.path}</code> · lines {shown.symbol.line}–{Math.max(shown.symbol.line, shown.symbol.endLine)}</p><pre className="code-block small">{shown.text}</pre></div>}
    </div>
    <details className="file-list"><summary>All {project.files.length} files</summary><ul>{project.files.map(f => <li key={f.path}><code>{f.path}</code> <span>{f.language} · {f.lines} lines</span></li>)}</ul></details>
  </section>;
}
