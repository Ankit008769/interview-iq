import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { ArrowLeft, CheckCircle2, CircleAlert, MessageSquareText, RotateCcw, Send, Sparkles, Star } from 'lucide-react';
import { ApiError, api, warmUpAI, type DesignEstimates, type DesignPromptDetail, type DesignSessionView, type StorageUnit } from '../lib/api';
import { AIConsent } from '../components/AIConsent';
import { LoadingScreen } from '../components/Layout';

// Excalidraw loads its fonts from the app (copied at build time), never from a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw-assets/`;

const VERDICT = { close: 'Close', order_of_magnitude: 'Right order of magnitude', off: 'More than 10 times off', missing: 'Not given' };
const TYPE = (t: string) => t.replace(/_/g, ' ').replace('sql db', 'relational database').replace('nosql db', 'NoSQL database');
const fmt = (x: number) => (x >= 1e12 ? `${(x / 1e12).toFixed(1)} TB` : x >= 1e9 ? `${(x / 1e9).toFixed(1)} GB` : x.toLocaleString('en-US', { maximumFractionDigits: 1 }));
const signature = (elements: readonly { version?: number; isDeleted?: boolean }[]) => `${elements.length}:${elements.reduce((n, e) => n + (e.version ?? 0) + (e.isDeleted ? 1 : 0), 0)}`;

export function DesignWorkspace() {
  const { id = '' } = useParams();
  const [prompt, setPrompt] = useState<DesignPromptDetail | null>(null);
  const [session, setSession] = useState<DesignSessionView | null>(null);
  const [extra, setExtra] = useState<{ expected: string[]; tradeoffs: string[] } | null>(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [explanation, setExplanation] = useState(''); const [estimates, setEstimates] = useState<DesignEstimates>({});
  const pending = useRef<{ scene?: unknown[]; explanation?: string; estimates?: DesignEstimates }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastScene = useRef('');

  const open = useCallback(async (create = false) => {
    setError('');
    try {
      const d = await api<{ prompt: DesignPromptDetail; sessions: { id: string; status: string }[] }>(`/design/prompts/${id}`);
      setPrompt(d.prompt);
      const latest = d.sessions[0];
      const s = create || !latest ? (await api<{ session: DesignSessionView }>('/design/sessions', { method: 'POST', body: JSON.stringify({ promptId: id }) })).session
        : (await api<{ session: DesignSessionView }>(`/design/sessions/${latest.id}`)).session;
      setSession(s); setExplanation(s.explanation); setEstimates(s.estimates ?? {}); setExtra(null); lastScene.current = '';
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void open(); warmUpAI(); }, [open]);

  // Drafts save themselves a moment after the last change.
  const flush = useCallback(async () => {
    if (!session || session.status !== 'drafting' || !Object.keys(pending.current).length) return;
    const body = pending.current; pending.current = {};
    setSaveState('saving');
    try { await api(`/design/sessions/${session.id}/draft`, { method: 'PUT', body: JSON.stringify(body) }); setSaveState(Object.keys(pending.current).length ? 'unsaved' : 'saved'); }
    catch { pending.current = { ...body, ...pending.current }; setSaveState('error'); }
  }, [session]);
  const queue = useCallback((change: typeof pending.current) => {
    pending.current = { ...pending.current, ...change }; setSaveState('unsaved');
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 1500);
  }, [flush]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function submit() {
    if (!session) return;
    clearTimeout(timer.current); await flush();
    setError('');
    try {
      const d = await api<{ session: DesignSessionView; expected?: string[]; tradeoffs?: string[] }>(`/design/sessions/${session.id}/submit`, { method: 'POST', body: '{}' });
      setSession(d.session); if (d.expected) setExtra({ expected: d.expected, tradeoffs: d.tradeoffs ?? [] });
    } catch (e) { setError((e as Error).message); }
  }

  if (!prompt || !session) return error ? <div className="alert error" role="alert">{error} <Link to="/design">Back to problems</Link></div> : <LoadingScreen/>;
  const drafting = session.status === 'drafting';
  const setEstimate = (next: DesignEstimates) => { setEstimates(next); queue({ estimates: next }); };
  return <div className="page-enter design-workspace">
    <Link to="/design" className="back-link"><ArrowLeft size={16}/> All design problems</Link>
    <div className="problem-head"><h1>{prompt.title}</h1><span className={`difficulty-chip ${prompt.difficulty.toLowerCase()}`}>{prompt.difficulty}</span>
      {!drafting && <button type="button" className="button secondary small-button" onClick={() => void open(true)}><RotateCcw size={15}/> New attempt</button>}</div>
    <div className="requirement-cards">
      <section className="card requirement-card" aria-label="Functional requirements"><h3>What it must do</h3><ul>{prompt.functional.map(f => <li key={f}>{f}</li>)}</ul></section>
      <section className="card requirement-card" aria-label="Non-functional requirements"><h3>How well</h3><ul>{prompt.nonFunctional.map(f => <li key={f}>{f}</li>)}</ul></section>
      <section className="card requirement-card" aria-label="Scale"><h3>Scale</h3><p>{prompt.scale}</p></section>
    </div>
    <section className="card board-card" aria-label="Design board">
      <div className="board-head"><p>{drafting ? 'Draw boxes and type a name inside each one (double-click a box), then connect them with arrows. Free text becomes notes.' : 'Submitted design (read-only).'}</p>
        {drafting && <span className={`save-state ${saveState}`} role="status">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved: retrying on the next change' : 'Unsaved changes'}</span>}</div>
      <div className="board">
        <Excalidraw key={session.id} theme="dark" viewModeEnabled={!drafting}
          // The dark theme inverts canvas colours, so a white background shows as dark.
          initialData={{ elements: session.scene as never, appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true }}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false } }}
          onChange={elements => {
            if (!drafting) return;
            const sig = signature(elements);
            if (lastScene.current === '') { lastScene.current = sig; return; }
            if (sig !== lastScene.current) { lastScene.current = sig; queue({ scene: elements.filter(e => !e.isDeleted) as unknown[] }); }
          }}/>
      </div>
      <p className="timing-note">The board is easiest on a larger screen. Images and embeds are not saved.</p>
    </section>
    <div className="design-inputs">
      <section className="card estimates-card" aria-label="Capacity estimates"><h3>Capacity estimates</h3>
        <p className="timing-note">Work them out from the scale card. They are checked by arithmetic when you submit.</p>
        {prompt.estimates.map(e => e.id === 'storagePerYear'
          ? <div key={e.id} className="estimate-row"><label className="field">{e.label}<input type="number" min={0} step="any" disabled={!drafting} value={estimates.storagePerYear?.value ?? ''}
              onChange={ev => setEstimate({ ...estimates, storagePerYear: ev.target.value === '' ? null : { value: Number(ev.target.value), unit: estimates.storagePerYear?.unit ?? 'TB' } })}/></label>
              <label className="field unit-field">Unit<select disabled={!drafting} value={estimates.storagePerYear?.unit ?? 'TB'}
                onChange={ev => setEstimate({ ...estimates, storagePerYear: { value: estimates.storagePerYear?.value ?? 0, unit: ev.target.value as StorageUnit } })}>{prompt.storageUnits.map(u => <option key={u}>{u}</option>)}</select></label></div>
          : <label key={e.id} className="field">{e.label}<input type="number" min={0} step="any" disabled={!drafting} value={estimates[e.id] ?? ''}
              onChange={ev => setEstimate({ ...estimates, [e.id]: ev.target.value === '' ? null : Number(ev.target.value) })}/></label>)}
      </section>
      <section className="card explanation-card" aria-label="Your reasoning"><h3>Your reasoning</h3>
        <label className="field">Key decisions and trade-offs<textarea rows={8} maxLength={4000} disabled={!drafting} value={explanation} placeholder="Why these components? Which database, and why? What happens when something fails?"
          onChange={ev => { setExplanation(ev.target.value); queue({ explanation: ev.target.value }); }}/></label>
        <span className="timing-note">{explanation.length} / 4000</span>
      </section>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {drafting && <button type="button" className="button primary submit-design" onClick={() => void submit()}><Send size={16}/> Submit design</button>}
    {!drafting && <Interpretation session={session} extra={extra}/>}
    {!drafting && <FollowUps session={session} onUpdate={setSession}/>}
  </div>;
}

function Interpretation({ session, extra }: { session: DesignSessionView; extra: { expected: string[]; tradeoffs: string[] } | null }) {
  const g = session.graph!;
  const label = new Map(g.nodes.map(n => [n.id, n.label]));
  return <section className="card interpretation" aria-label="How your design was read"><h3>How your design was read</h3>
    <div className="interpretation-grid">
      <div><h4>{g.nodes.length} components</h4><ul>{g.nodes.map(n => <li key={n.id}><b>{n.label}</b> <span>{TYPE(n.type)}</span></li>)}</ul></div>
      <div><h4>{g.edges.length} connections</h4><ul>{g.edges.map((e, i) => <li key={i}>{label.get(e.from)} → {label.get(e.to)}{e.label ? ` (${e.label})` : ''}</li>)}</ul>
        {g.notes.length > 0 && <><h4>Notes</h4><ul>{g.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}</div>
    </div>
    {session.analysis!.observations.length > 0 && <ul className="observations">{session.analysis!.observations.map(o => <li key={o}><CircleAlert size={14}/> {o}</li>)}</ul>}
    <h4>Capacity estimates</h4>
    <ul className="estimate-results">{session.estimateCheck!.map(e => <li key={e.id} className={e.verdict}><b>{e.label}:</b> {e.given === null ? 'not given' : fmt(e.given)} — {VERDICT[e.verdict]}
      {e.ratio !== null && e.verdict !== 'close' ? ` (${e.ratio > 1 ? `${e.ratio.toFixed(1)}× too high` : `${(1 / e.ratio).toFixed(1)}× too low`})` : ''}<span className="formula">Reference: {e.formula}</span></li>)}</ul>
    {extra && <p className="timing-note">Designs for this problem usually include {extra.expected.map(TYPE).join(', ')}. Interviewers often probe: {extra.tradeoffs.join('; ')}.</p>}
  </section>;
}

function FollowUps({ session, onUpdate }: { session: DesignSessionView; onUpdate: (s: DesignSessionView) => void }) {
  const [answer, setAnswer] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [needsConsent, setNeedsConsent] = useState(false);
  const call = async (path: string, body: object = {}, timeoutMs = 300_000) => {
    setBusy(true); setError('');
    try { const d = await api<{ session: DesignSessionView }>(`/design/sessions/${session.id}/${path}`, { method: 'POST', body: JSON.stringify(body), timeoutMs }); onUpdate(d.session); setNeedsConsent(false); return true; }
    catch (e) { if (e instanceof ApiError && e.status === 409 && /consent/i.test(e.message)) setNeedsConsent(true); setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const open = session.followUps.find(f => !f.answer);
  const canAsk = session.status === 'submitted' && !open && session.followUps.length < 2;
  const canReview = session.status === 'submitted' && session.followUps.length === 2 && !open;
  let next: ReactNode = null;
  if (canAsk) next = <button type="button" className="button primary" disabled={busy} onClick={() => void call('follow-ups')}>{busy ? 'The interviewer is reading your design…' : session.followUps.length ? 'Next question' : 'Get the interviewer\'s first question'}</button>;
  else if (open) next = <><label className="field">Your answer<textarea rows={4} maxLength={2000} value={answer} onChange={e => setAnswer(e.target.value)} placeholder="How does your design change, and what does it cost?"/></label>
    <button type="button" className="button primary" disabled={busy || answer.trim().length < 10} onClick={async () => { if (await call(`follow-ups/${open.index}/answer`, { answer }, 30_000)) setAnswer(''); }}>Save answer</button></>;
  else if (canReview) next = <button type="button" className="button primary" disabled={busy} onClick={() => void call('review')}>{busy ? 'Reviewing your design… this can take a minute' : 'Get the review'}</button>;
  return <section className="card follow-up design-follow-up" aria-label="Interviewer follow-up"><h3><Sparkles size={17}/> Changing constraints</h3>
    <p>The interviewer changes one requirement at a time and asks how your design copes. Rate how relevant each question felt; it helps us improve them.</p>
    {session.followUps.map(f => <div key={f.index} className="design-question">
      <p className="interviewer-question"><MessageSquareText size={17}/> {f.question}</p>
      {f.answer && <blockquote className="your-answer">{f.answer}</blockquote>}
      <div className="rating" role="group" aria-label={`Relevance of question ${f.index + 1}`}>{[1, 2, 3, 4, 5].map(n =>
        <button type="button" key={n} aria-pressed={f.rating === n} aria-label={`${n} out of 5`} className={f.rating && n <= f.rating ? 'on' : ''} disabled={busy}
          onClick={() => void call(`follow-ups/${f.index}/rating`, { rating: n }, 30_000)}><Star size={16}/></button>)}<span>How relevant was this question?</span></div>
    </div>)}
    {next}
    {error && <div className="alert error" role="alert">{error}</div>}
    {needsConsent && <AIConsent onChange={ready => { if (ready) { setNeedsConsent(false); setError(''); } }}/>}
    {session.review && <div className="design-review"><h3><CheckCircle2 size={17}/> Review</h3><p className="review-summary">{session.review.summary}</p>
      <ul className="review-criteria">{session.review.criteria.map(c => <li key={c.criterionId}>
        <div className="criterion-head"><b>{c.label}</b><span className="criterion-score">{c.score === null ? 'Not enough evidence' : `${c.score}/5`}</span></div>
        <p>{c.rationale}</p>{c.evidence && <p className="criterion-quote">“{c.evidence.quote}”</p>}{c.improvement && <p className="criterion-tip">Try: {c.improvement}</p>}
      </li>)}</ul></div>}
  </section>;
}
