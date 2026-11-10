import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarClock, CalendarDays, Flame, GraduationCap, Repeat, Sparkles, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { api, timeZone, warmUpAI, type Drill, type Interview, type InterviewType, type LearningOverview, type ProgressReport, type SkillView, type StudyPlan } from '../lib/api';
import { AIConsent } from '../components/AIConsent';
import { LoadingScreen } from '../components/Layout';

const TYPES: InterviewType[] = ['Technical', 'Behavioral', 'HR'];
const KIND_LABELS: Record<Drill['kind'], string> = { retest: 'Spaced retest', weakest: 'Lowest estimate', foundation: 'Foundation first', baseline: 'First estimate', chosen: 'Your choice' };
const QUESTIONS_FOR: Record<10 | 20 | 30, string> = { 10: '2 questions', 20: '3 questions', 30: '4 questions' };
const zoneHeaders = () => ({ 'x-time-zone': timeZone() });
const dateLabel = (value: string, withYear = false) => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: value.length === 10 ? 'UTC' : undefined }).format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value));
const localISODate = (offsetDays = 0) => { const d = new Date(Date.now() + offsetDays * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Daily drills chosen from the learner's skill estimates (roadmap C5).
export function Learn() {
  const navigate = useNavigate();
  const [data, setData] = useState<LearningOverview | null>(null); const [report, setReport] = useState<ProgressReport | null>(null);
  const [error, setError] = useState(''); const [consented, setConsented] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(''); const [startError, setStartError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [overview, progress, consent] = await Promise.all([api<LearningOverview>('/learning/overview', { headers: zoneHeaders() }),
        api<ProgressReport>('/learning/report?weeks=4', { headers: zoneHeaders() }), api<{ accepted: boolean }>('/account/ai-consent')]);
      setData(overview); setReport(progress); setConsented(consent.accepted);
      if (overview.aiAvailable && overview.drill) warmUpAI();
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function start(drill: Drill) {
    setStarting(drill.skillId); setStartError('');
    try { const d = await api<{ interview: Interview }>('/interviews', { method: 'POST', body: JSON.stringify(drill.config), timeoutMs: 180_000 }); navigate(`/interview/${d.interview._id}`); }
    catch (e) { setStartError((e as Error).message); setStarting(''); }
  }
  async function practise(skillId: string) {
    setStartError('');
    try { const { drill } = await api<{ drill: Drill }>(`/learning/drill?skillId=${encodeURIComponent(skillId)}`); if (drill) await start(drill); }
    catch (e) { setStartError((e as Error).message); }
  }
  if (!data) return error ? <div className="alert error" role="alert">{error} <button className="button secondary" onClick={() => void load()}>Retry</button></div> : <LoadingScreen/>;
  const canStart = data.aiAvailable && consented === true && !starting;
  return <div className="page-enter learn-page">
    <div className="page-heading"><div><span className="eyebrow"><GraduationCap size={14}/> ADAPTIVE PRACTICE</span><h1>Learn</h1><p>A short drill each day, chosen from the skills that are due for a retest or have the lowest estimates.</p></div></div>
    <div className="metrics">
      <div className="metric card"><div className="metric-icon purple"><Target size={20}/></div><span className="metric-label">Readiness{data.plan ? ' for your focus areas' : ''}</span><div className="metric-value">{data.readiness === null ? '—' : `${data.readiness}%`}</div><span className="metric-note">{data.readiness === null ? 'Finish an AI-scored interview or drill to get one' : 'Lowered while estimates are uncertain. Not a hiring prediction.'}</span></div>
      <div className="metric card"><div className="metric-icon mint"><Flame size={20}/></div><span className="metric-label">Practice streak</span><div className="metric-value">{data.streak.days} {data.streak.days === 1 ? 'day' : 'days'}</div><span className="metric-note">{data.streak.practisedToday ? 'Practised today' : data.streak.days ? 'Practise today to keep it going' : 'Any AI-scored session counts'}</span></div>
      <div className="metric card"><div className="metric-icon blue"><Repeat size={20}/></div><span className="metric-label">Retests due</span><div className="metric-value">{data.dueCount}</div><span className="metric-note">{data.upcoming.length ? `${data.upcoming.length} more in the next 7 days` : 'Spaced retests keep what you learned'}</span></div>
    </div>
    <div className="learn-grid">
      <section className="card drill-card" aria-label="Today's drill">
        <span className="eyebrow"><Sparkles size={14}/> TODAY'S DRILL</span>
        {!data.aiAvailable ? <p>Drills need AI scoring, which is not enabled on this server.</p> : !data.drill ? <p>No drill is available yet.</p> : <>
          <span className={`kind-chip ${data.drill.kind}`}>{KIND_LABELS[data.drill.kind]}</span>
          <h2>{data.drill.skillLabel}</h2>
          <p>{data.drill.reason}</p>
          <p className="drill-meta">{data.drill.config.type} · {data.drill.config.topic} · {data.drill.config.difficulty} · {data.drill.config.totalQuestions} questions · {data.drill.config.timeLimitSeconds / 60} min each</p>
          {consented === false && <AIConsent onChange={ready => setConsented(ready)}/>}
          {startError && <div className="alert error" role="alert">{startError}</div>}
          <button className="button primary" disabled={!canStart} onClick={() => void start(data.drill!)}>{starting === data.drill.skillId ? 'Writing your first question… this can take a minute or two if the AI model was idle' : "Start today's drill"} <ArrowRight size={17}/></button>
        </>}
      </section>
      <PlanCard plan={data.plan} onSaved={() => void load()}/>
    </div>
    <div className="section-title space-top"><div><h3>Your skills</h3><p>Each bar shows the estimate on the 0–5 rubric scale and the range it is likely to be in. The range narrows as you practise and widens again after a long break.</p></div></div>
    <div className="skill-groups">{TYPES.map(type => <section key={type} className="card skill-group" aria-label={`${type} skills`}>
      <div className="skill-group-head"><h3>{type}</h3><span>{data.readinessByType[type] === null ? 'No estimate yet' : `Readiness ${data.readinessByType[type]}%`}</span></div>
      {data.skills.filter(s => s.type === type).map(skill => <SkillRow key={skill.id} skill={skill} busy={!!starting} canStart={canStart} onPractise={() => void practise(skill.id)}/>)}
    </section>)}</div>
    {data.upcoming.length > 0 && <><div className="section-title space-top"><div><h3>Coming up</h3><p>Spaced retests in the next 7 days</p></div></div>
      <div className="card upcoming-card"><ul>{data.upcoming.map(u => <li key={u.skillId}><CalendarClock size={15}/> <b>{u.label}</b> <span>{dateLabel(u.due)}</span></li>)}</ul></div></>}
    {report && <ProgressCard report={report}/>}
    <details className="card rubric-guide learn-method"><summary>How estimates and drills work</summary>
      <p>Every AI-scored interview or drill rates your answers on a 0–5 rubric. Each skill keeps an estimate and an uncertainty: a new score moves the estimate in proportion to how uncertain it was, harder questions count a little more, and a criterion with no evidence in your answers counts as a weak 0, the same way it lowers the interview score.</p>
      <p>Retests are scheduled with FSRS spaced repetition: a strong result pushes the next retest further away, a weak one brings it closer. When a skill builds on a weaker one, such as trade-offs on depth of understanding, the drill starts with the foundation.</p>
      <p>Readiness is 20 × the average over your focus areas of (estimate − one standard deviation), so it stays low until there is enough evidence. These are coaching estimates from an AI judge, not predictions of hiring outcomes, and they have not yet been validated against learner results.</p>
    </details>
  </div>;
}

function SkillRow({ skill, busy, canStart, onPractise }: { skill: SkillView; busy: boolean; canStart: boolean; onPractise: () => void }) {
  return <div className="skill-row">
    <div className="skill-name"><b>{skill.label}</b>{skill.practised ? <span className={`level-chip ${skill.level.toLowerCase().replace(' ', '-')}`}>{skill.level}</span> : <span className="level-chip none">Not practised yet</span>}</div>
    {skill.practised ? <>
      <div className="skill-bar" role="img" aria-label={`Estimate ${skill.mean.toFixed(1)} of 5, likely between ${skill.lower.toFixed(1)} and ${skill.upper.toFixed(1)}`}>
        <span className="skill-band" style={{ left: `${skill.lower * 20}%`, width: `${(skill.upper - skill.lower) * 20}%` }}/>
        <span className="skill-marker" style={{ left: `${skill.mean * 20}%` }}/>
      </div>
      <div className="skill-meta"><span>{skill.mean.toFixed(1)} of 5 ({skill.lower.toFixed(1)}–{skill.upper.toFixed(1)})</span>
        {skill.lowConfidence && <span className="low-confidence">Low confidence: practise again to narrow it</span>}
        <span>{skill.isDue ? <b className="due-now">Retest due</b> : `Next retest ${dateLabel(skill.due)}`}</span>
        <Trend points={skill.history}/></div>
    </> : <div className="skill-meta"><span>No AI-scored answers for this skill yet.</span></div>}
    <button className="button secondary small-button" disabled={busy || !canStart} onClick={onPractise}>Practise</button>
  </div>;
}

function Trend({ points }: { points: { mean: number }[] }) {
  if (points.length < 2) return null;
  const path = points.map((p, i) => `${(i / (points.length - 1)) * 60},${18 - (p.mean / 5) * 18}`).join(' ');
  return <svg className="trend" viewBox="0 0 60 18" width="60" height="18" role="img" aria-label={`Trend over the last ${points.length} sessions`}><polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>;
}

function PlanCard({ plan, onSaved }: { plan: StudyPlan | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(!plan);
  const [date, setDate] = useState(plan?.interviewDate ?? localISODate(21)); const [types, setTypes] = useState<InterviewType[]>(plan?.focusTypes ?? ['Technical']);
  const [minutes, setMinutes] = useState<10 | 20 | 30>(plan?.dailyMinutes ?? 10); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setEditing(!plan); }, [plan]);
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/learning/plan', { method: 'PUT', headers: zoneHeaders(), body: JSON.stringify({ interviewDate: date, focusTypes: types, dailyMinutes: minutes }) }); onSaved(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await api('/learning/plan', { method: 'DELETE' }); onSaved(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  if (plan && !editing) return <section className="card plan-card" aria-label="Study plan">
    <span className="eyebrow"><CalendarDays size={14}/> STUDY PLAN</span>
    <h2>{plan.daysLeft < 0 ? 'Your interview date has passed' : plan.daysLeft === 0 ? 'Your interview is today' : `${plan.daysLeft} ${plan.daysLeft === 1 ? 'day' : 'days'} to your interview`}</h2>
    <p>{dateLabel(plan.interviewDate, true)} · Focus: {plan.focusTypes.join(', ')} · {plan.dailyMinutes} min a day ({QUESTIONS_FOR[plan.dailyMinutes]} per drill)</p>
    {plan.daysLeft >= 0 && <p className="timing-note">At one drill a day you have about {Math.max(1, plan.daysLeft)} {plan.daysLeft === 1 ? 'session' : 'sessions'} left. Retests and weak skills in your focus areas come first.</p>}
    {error && <div className="alert error" role="alert">{error}</div>}
    <div className="plan-actions"><button className="button secondary" disabled={busy} onClick={() => setEditing(true)}>{plan.daysLeft < 0 ? 'Set a new date' : 'Edit plan'}</button><button className="button secondary" disabled={busy} onClick={() => void remove()}>Remove plan</button></div>
  </section>;
  return <form className="card plan-card" aria-label="Study plan" onSubmit={save}>
    <span className="eyebrow"><CalendarDays size={14}/> STUDY PLAN</span>
    <h2>{plan ? 'Edit your plan' : 'Plan for an interview'}</h2>
    <p>Drills focus on the interview types you choose and fit your daily time.</p>
    <label className="field">Interview date<input type="date" value={date} min={localISODate()} max={localISODate(365)} onChange={e => setDate(e.target.value)} required/></label>
    <fieldset className="focus-types"><legend>Focus areas</legend>{TYPES.map(t => <label key={t} className="consent-check"><input type="checkbox" checked={types.includes(t)} onChange={e => setTypes(e.target.checked ? [...types, t] : types.filter(x => x !== t))}/> {t}</label>)}</fieldset>
    <div className="segmented" role="group" aria-label="Minutes a day">{([10, 20, 30] as const).map(m => <button type="button" key={m} aria-pressed={minutes === m} className={minutes === m ? 'active' : ''} onClick={() => setMinutes(m)}>{m} min</button>)}</div>
    <p className="timing-note">{minutes} minutes a day: {QUESTIONS_FOR[minutes]} per drill.</p>
    {error && <div className="alert error" role="alert">{error}</div>}
    <div className="plan-actions"><button className="button primary" disabled={busy || !types.length}>Save plan</button>{plan && <button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}</div>
  </form>;
}

function ProgressCard({ report }: { report: ProgressReport }) {
  const change = (c: ProgressReport['gains'][number]) => <li key={c.skillId}><b>{c.label}</b> <span>{c.change > 0 ? '+' : ''}{c.change.toFixed(1)} ({c.from.toFixed(1)} → {c.to.toFixed(1)}{c.sinceFirstPractice ? ', since first practised' : ''})</span></li>;
  return <><div className="section-title space-top"><div><h3>Progress report</h3><p>The last four weeks, newest first, and the skills that moved most in the last 28 days</p></div></div>
    <div className="card progress-card">
      <div className="table-scroll"><table className="report-table"><thead><tr><th scope="col">Week</th><th scope="col">Drills</th><th scope="col">Interviews</th><th scope="col">Average AI score</th></tr></thead>
        <tbody>{report.weeks.map(w => <tr key={w.end}><td>{dateLabel(w.start)} – {dateLabel(w.end)}</td><td>{w.drills}</td><td>{w.interviews}</td><td>{w.averageScore === null ? '—' : `${w.averageScore}/100`}</td></tr>)}</tbody></table></div>
      <div className="change-grid">
        <div><h4><TrendingUp size={16}/> Biggest gains</h4>{report.gains.length ? <ul>{report.gains.map(change)}</ul> : <p>None yet. Gains show after two or more sessions on a skill.</p>}</div>
        <div><h4 className="amber"><TrendingDown size={16}/> Needs attention</h4>{report.declines.length ? <ul>{report.declines.map(change)}</ul> : <p>No skill went down.</p>}</div>
      </div>
    </div></>;
}
