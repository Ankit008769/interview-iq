import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, MessageSquareText, Play, RotateCcw, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { ApiError, api, type CodeLang, type CodeRun, type CodeRunSummary, type CodeVerdict, type CodingProblem, type CodingStatus } from '../lib/api';
import { CodeEditor } from '../components/CodeEditor';
import { AIConsent } from '../components/AIConsent';
import { LoadingScreen } from '../components/Layout';

const LANGUAGE_LABELS: Record<CodeLang, string> = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python 3', java: 'Java 17', cpp: 'C++17', sql: 'SQL (SQLite)' };
const VERDICTS: Record<CodeVerdict, string> = { accepted: 'Accepted', wrong_answer: 'Wrong answer', runtime_error: 'Runtime error', time_limit: 'Time limit exceeded',
  memory_limit: 'Memory limit exceeded', output_limit: 'Output limit exceeded', compile_error: 'Compilation error', runner_error: 'Runner error' };
const draftKey = (id: string, language: CodeLang) => `iq-code:v1:${id}:${language}`;
const readDraft = (id: string, language: CodeLang) => { try { return localStorage.getItem(draftKey(id, language)); } catch { return null; } };
const writeDraft = (id: string, language: CodeLang, code: string) => { try { localStorage.setItem(draftKey(id, language), code); } catch { /* storage unavailable */ } };
const show = (value: unknown) => { const text = JSON.stringify(value); return text === undefined ? 'undefined' : text.length > 400 ? `${text.slice(0, 400)}…` : text; };

// Problem text uses blank lines between paragraphs and `backticks` for code.
function Statement({ text }: { text: string }) {
  return <>{text.split('\n\n').map((paragraph, i) => <p key={i}>{paragraph.split(/(`[^`]+`)/).map((part, j) => part.startsWith('`') && part.endsWith('`') ? <code key={j}>{part.slice(1, -1)}</code> : part)}</p>)}</>;
}
function Rows({ columns, rows }: { columns?: string[]; rows: unknown }) {
  const list = Array.isArray(rows) ? rows as unknown[][] : [];
  if (!list.length) return <p className="empty-rows">No rows</p>;
  return <div className="table-scroll"><table className="rows-table">{columns && <thead><tr>{columns.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead>}
    <tbody>{list.map((row, i) => <tr key={i}>{(Array.isArray(row) ? row : [row]).map((cell, j) => <td key={j}>{cell === null ? 'NULL' : String(cell)}</td>)}</tr>)}</tbody></table></div>;
}

export function CodingProblemPage() {
  const { id = '' } = useParams();
  const [problem, setProblem] = useState<CodingProblem | null>(null);
  const [runs, setRuns] = useState<CodeRunSummary[]>([]);
  const [status, setStatus] = useState<CodingStatus | null>(null);
  const [error, setError] = useState('');
  const [language, setLanguage] = useState<CodeLang>('python');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'' | 'run' | 'submit'>('');
  const [runError, setRunError] = useState('');
  const [result, setResult] = useState<CodeRun | null>(null);
  useEffect(() => {
    setProblem(null); setResult(null); setError('');
    api<{ problem: CodingProblem; runs: CodeRunSummary[] }>(`/coding/problems/${id}`).then(d => {
      setProblem(d.problem); setRuns(d.runs);
      const preferred = (() => { try { return localStorage.getItem('iq-code:v1:language') as CodeLang | null; } catch { return null; } })();
      const first = preferred && d.problem.languages.includes(preferred) ? preferred : d.problem.languages.includes('python') ? 'python' : d.problem.languages[0];
      setLanguage(first); setCode(readDraft(d.problem.id, first) ?? d.problem.starters[first] ?? '');
    }).catch(e => setError(e.message));
    api<CodingStatus>('/coding/status').then(setStatus).catch(() => {});
  }, [id]);
  const changeLanguage = (next: CodeLang) => {
    if (!problem) return;
    setLanguage(next); setCode(readDraft(problem.id, next) ?? problem.starters[next] ?? '');
    try { localStorage.setItem('iq-code:v1:language', next); } catch { /* storage unavailable */ }
  };
  const edit = useCallback((value: string) => { setCode(value); if (problem) writeDraft(problem.id, language, value); }, [problem, language]);
  const execute = useCallback(async (mode: 'run' | 'submit') => {
    if (!problem || busy || !code.trim()) return;
    setBusy(mode); setRunError('');
    try {
      const { run } = await api<{ run: CodeRun }>(`/coding/problems/${problem.id}/runs`, { method: 'POST', body: JSON.stringify({ language, source: code, mode }), timeoutMs: 120_000 });
      setResult(run); setRuns(r => [run, ...r].slice(0, 10));
    } catch (e) { setRunError((e as Error).message); }
    finally { setBusy(''); }
  }, [problem, busy, code, language]);
  async function openRun(runId: string) {
    try { const { run } = await api<{ run: CodeRun }>(`/coding/runs/${runId}`); setResult(run); } catch (e) { setRunError((e as Error).message); }
  }
  if (!problem) return error ? <div className="alert error" role="alert">{error} <Link to="/coding">Back to problems</Link></div> : <LoadingScreen/>;
  const runnerLanguage = (l: CodeLang) => (l === 'sql' ? 'python' : l);
  const unavailable = (l: CodeLang) => !!status?.runner.ready && !status.runner.languages[runnerLanguage(l)];
  const sql = problem.kind === 'sql';
  return <div className="page-enter coding-problem">
    <Link to="/coding" className="back-link"><ArrowLeft size={16}/> All problems</Link>
    <div className="problem-head"><h1>{problem.title}</h1><span className={`difficulty-chip ${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span><span className="problem-topics">{problem.topics.join(' · ')}</span></div>
    <div className="workspace-grid">
      <section className="card statement-card" aria-label="Problem">
        <Statement text={problem.statement}/>
        {sql && problem.schema && <><h3>Schema</h3><pre className="code-block">{problem.schema}</pre></>}
        {problem.signature && <p className="signature-note">Write <code>{problem.signature.name}</code>({problem.signature.params.map(p => `${p.name}: ${p.type}`).join(', ')}) → {problem.signature.returns}{problem.compare && problem.compare !== 'exact' ? '. The order of the result does not matter.' : '.'}</p>}
        <h3>Examples</h3>
        {problem.examples.map((example, i) => <div key={i} className="example-block">
          <b>Example {i + 1}</b>
          {sql ? <><span className="example-label">Data</span><pre className="code-block small">{String(example.args[0])}</pre><span className="example-label">Expected result</span><Rows columns={problem.columns} rows={example.expected}/></>
            : <><p><span className="example-label">Input</span> <code>{problem.signature!.params.map((p, k) => `${p.name} = ${show(example.args[k])}`).join(', ')}</code></p>
              <p><span className="example-label">Output</span> <code>{show(example.expected)}</code></p></>}
          {example.explanation && <p className="example-explanation">{example.explanation}</p>}
        </div>)}
        <h3>Constraints</h3><ul className="constraints">{problem.constraints.map(c => <li key={c}>{c}</li>)}</ul>
        <p className="hidden-note"><ShieldCheck size={15}/> Submitting also runs {problem.hiddenTests} hidden tests, including large inputs that check efficiency.</p>
      </section>
      <section className="card editor-card" aria-label="Your solution">
        <div className="editor-toolbar">
          <label className="field language-field">Language<select value={language} onChange={e => changeLanguage(e.target.value as CodeLang)}>
            {problem.languages.map(l => <option key={l} value={l} disabled={unavailable(l)}>{LANGUAGE_LABELS[l]}{unavailable(l) ? ' (unavailable)' : ''}</option>)}</select></label>
          <button type="button" className="button secondary small-button" onClick={() => { if (confirm('Replace your code with the starter code?')) edit(problem.starters[language] ?? ''); }}><RotateCcw size={15}/> Reset</button>
        </div>
        {language === 'cpp' && <p className="editor-note">Standard headers and <code>using namespace std</code> are already included.</p>}
        {language === 'java' && <p className="editor-note"><code>java.util.*</code> is already imported. Keep your class named <code>Solution</code>.</p>}
        <CodeEditor value={code} language={language} onChange={edit} onRun={() => void execute('run')} label={`${LANGUAGE_LABELS[language]} solution`}/>
        {status && !status.runner.ready && <p className="alert warning" role="status">The code runner is starting or unavailable. Running may fail; try again in a minute.</p>}
        {runError && <div className="alert error" role="alert">{runError}</div>}
        <div className="editor-actions">
          <button type="button" className="button secondary" disabled={!!busy} onClick={() => void execute('run')}><Play size={16}/> {busy === 'run' ? 'Running…' : 'Run examples'}</button>
          <button type="button" className="button primary" disabled={!!busy} onClick={() => void execute('submit')}><Send size={16}/> {busy === 'submit' ? 'Running all tests…' : 'Submit'}</button>
        </div>
        {result && result.problemId === problem.id && <Results run={result} problem={problem} onUpdate={setResult}/>}
        {runs.length > 0 && <details className="recent-runs"><summary>Recent runs ({runs.length})</summary><ul>{runs.map(r => <li key={r.id}>
          <button type="button" className="link-button" onClick={() => void openRun(r.id)}>{r.mode === 'submit' ? 'Submission' : 'Example run'} · {LANGUAGE_LABELS[r.language]} · <span className={`verdict-text ${r.verdict}`}>{VERDICTS[r.verdict]}</span> · {r.passed}/{r.total} · {new Date(r.createdAt).toLocaleString()}</button>
        </li>)}</ul></details>}
      </section>
    </div>
  </div>;
}

function Results({ run, problem, onUpdate }: { run: CodeRun; problem: CodingProblem; onUpdate: (run: CodeRun) => void }) {
  const visible = run.tests.filter(t => t.visible);
  const hidden = run.tests.filter(t => !t.visible);
  const largeTrouble = hidden.some(t => t.large && t.status !== 'passed');
  const sql = problem.kind === 'sql';
  return <div className="results-panel" aria-live="polite">
    <div className={`verdict-banner ${run.verdict === 'accepted' ? 'good' : 'bad'}`}>
      {run.verdict === 'accepted' ? <CheckCircle2 size={20}/> : <CircleAlert size={20}/>}
      <div><b>{run.mode === 'run' && run.verdict === 'accepted' ? 'Examples passed' : VERDICTS[run.verdict]}</b>
        <span>{run.mode === 'run' ? 'Examples' : 'All tests'}: {run.passed}/{run.total} passed{run.runMs !== undefined ? ` · ran in ${run.runMs} ms` : ''}{run.compileMs ? ` · compiled in ${run.compileMs} ms` : ''}</span></div>
    </div>
    {run.message && run.verdict !== 'accepted' && <pre className="code-block error-block">{run.message}</pre>}
    {visible.map(t => { const example = problem.examples[t.index];
      return <div key={t.index} className={`test-row ${t.status}`}>
        <b>Example {t.index + 1}: {t.status === 'passed' ? 'passed' : t.status === 'wrong_answer' ? 'wrong answer' : t.status === 'error' ? 'error' : 'not run'}</b>{t.ms !== undefined && <span className="test-ms"><Clock3 size={13}/> {t.ms} ms</span>}
        {t.status === 'wrong_answer' && example && (sql ? <div className="compare-rows"><div><span className="example-label">Expected</span><Rows columns={problem.columns} rows={example.expected}/></div><div><span className="example-label">Yours</span><Rows rows={t.actual}/></div></div>
          : <p><span className="example-label">Expected</span> <code>{show(example.expected)}</code> <span className="example-label">Yours</span> <code>{show(t.actual)}</code></p>)}
        {t.error && <pre className="code-block error-block small">{t.error}</pre>}
      </div>; })}
    {hidden.length > 0 && <p className="hidden-summary">Hidden tests: {hidden.filter(t => t.status === 'passed').length}/{hidden.length} passed.{largeTrouble ? ' A large input failed or did not finish in time, which usually points to time complexity.' : ''}</p>}
    {run.output && <details className="program-output"><summary>Program output</summary><pre className="code-block small">{run.output}</pre></details>}
    {run.mode === 'submit' && run.verdict !== 'compile_error' && run.verdict !== 'runner_error' && <FollowUp key={run.id} run={run} onUpdate={onUpdate}/>}
  </div>;
}

function FollowUp({ run, onUpdate }: { run: CodeRun; onUpdate: (run: CodeRun) => void }) {
  const [answer, setAnswer] = useState(run.followUp?.answer ?? ''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [needsConsent, setNeedsConsent] = useState(false);
  useEffect(() => { if (run.followUp?.answer !== undefined) setAnswer(run.followUp.answer); }, [run.followUp?.answer]);
  const call = async (path: string, body: object) => {
    setBusy(true); setError('');
    try { const d = await api<{ run: CodeRun }>(`/coding/runs/${run.id}/${path}`, { method: 'POST', body: JSON.stringify(body), timeoutMs: 300_000 }); onUpdate(d.run); setNeedsConsent(false); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && /consent/i.test(e.message)) setNeedsConsent(true);
      setError((e as Error).message);
      // A timeout or failed review does not mean the answer was lost. Recover the server snapshot.
      try { const d = await api<{ run: CodeRun }>(`/coding/runs/${run.id}`); onUpdate(d.run); } catch { /* keep the local draft until recovery is possible */ }
    }
    finally { setBusy(false); }
  };
  const followUp = run.followUp;
  const review = followUp?.review;
  let body: ReactNode;
  if (!followUp) body = <><p>The interviewer asks one question about your approach, as in a live coding round. Answering it gets you feedback on your approach, complexity reasoning, code quality and explanation.</p>
    <button type="button" className="button primary" disabled={busy} onClick={() => void call('follow-up', {})}>{busy ? 'The interviewer is reading your code…' : 'Get the interviewer\'s question'}</button></>;
  else if (!review) body = <><p className="interviewer-question"><MessageSquareText size={17}/> {followUp.question}</p>
    <label className="field">Your answer<textarea value={answer} onChange={e => setAnswer(e.target.value)} readOnly={busy || followUp.answer !== undefined} rows={5} maxLength={3500} placeholder="Explain your approach, its time and space complexity, and any trade-offs."/></label>
    {followUp.answer !== undefined && <p role="status">Your explanation is saved. You can retry its review.</p>}
    <button type="button" className="button primary" disabled={busy || answer.trim().length < 10} onClick={() => void call('answer', { answer })}>{busy ? 'Reviewing… this can take a minute' : followUp.answer !== undefined ? 'Retry review' : 'Get feedback'}</button></>;
  else body = <>
    <p className="interviewer-question"><MessageSquareText size={17}/> {followUp.question}</p>
    <blockquote className="your-answer">{followUp.answer}</blockquote>
    <p className="review-summary">{review.summary}</p>
    <p className="review-note">These ratings judge your code and explanation. Whether the code is correct comes only from the test results above.</p>
    <ul className="review-criteria">{review.criteria.map(c => <li key={c.criterionId}>
      <div className="criterion-head"><b>{c.label}</b><span className="criterion-score">{c.score === null ? 'Not enough evidence' : `${c.score}/5`}</span></div>
      <p>{c.rationale}</p>
      {c.evidence && <p className="criterion-quote">“{c.evidence.quote}”</p>}
      {c.improvement && <p className="criterion-tip">Try: {c.improvement}</p>}
    </li>)}</ul></>;
  return <section className="follow-up card" aria-label="Interviewer follow-up"><h3><Sparkles size={17}/> Interviewer follow-up</h3>{body}
    {error && <div className="alert error" role="alert">{error}</div>}
    {needsConsent && <AIConsent onChange={ready => { if (ready) { setNeedsConsent(false); setError(''); } }}/>}
  </section>;
}
