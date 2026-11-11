import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, CheckCircle2, ChevronRight, Copy, Download, FileSpreadsheet, Gauge, ListChecks, Package, Plus, RefreshCw, Settings, Trash2, Upload, Users } from 'lucide-react';
import { api, ORG_ROLE_LABELS, STYLE_LABELS, type AssignmentSpec, type CodingProblemSummary, type CohortReport, type DesignPromptSummary, type DrivePack, type ImportResult,
  type InterviewStyle, type InterviewType, type OrgDetail, type OrgInvitation, type OrgMember, type OrgOverview, type OrgRole } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const pct = (n: number | null) => (n === null ? '—' : String(n));
const KIND = { interview: 'Interview', coding: 'Coding', design: 'System design' } as const;
const CSV_EXAMPLE = 'email,name,cohort,roll_number,role\nasha@college.edu,Asha Verma,CSE 2027,21CS001,student';
const localDateTime = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function useOrg(orgId: string) {
  const [detail, setDetail] = useState<OrgDetail | null>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setDetail(await api<OrgDetail>(`/orgs/${orgId}`)); } catch (e) { setError((e as Error).message); } }, [orgId]);
  useEffect(() => { void load(); }, [load]);
  return { detail, error, load };
}
function OrgHeading({ detail, children }: { detail: OrgDetail; children?: ReactNode }) {
  const accent = detail.org.branding?.accentColor;
  return <div className="page-heading org-heading" style={accent ? { borderLeftColor: accent } : undefined}><div><span className="eyebrow"><Building2 size={14}/> {ORG_ROLE_LABELS[detail.org.role].toUpperCase()}</span>
    <h1>{detail.org.branding?.displayName || detail.org.name}</h1>{children}</div></div>;
}

// Placement-office dashboard: join code, cohorts, members and invitations, settings.
export function OrgPage() {
  const { orgId = '' } = useParams(); const navigate = useNavigate();
  const { detail, error: loadError, load } = useOrg(orgId);
  const [members, setMembers] = useState<{ members: OrgMember[]; invitations: OrgInvitation[] } | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [cohortName, setCohortName] = useState(''); const [csv, setCsv] = useState(''); const [imported, setImported] = useState<ImportResult | null>(null);
  const [settings, setSettings] = useState({ name: '', displayName: '', accentColor: '#8266f2' }); const [confirmName, setConfirmName] = useState('');
  const staff = detail && detail.org.role !== 'student'; const admin = detail?.org.role === 'admin';

  const loadMembers = useCallback(async () => { try { setMembers(await api(`/orgs/${orgId}/members`)); } catch (e) { setError((e as Error).message); } }, [orgId]);
  useEffect(() => { if (staff) void loadMembers(); }, [staff, loadMembers]);
  useEffect(() => { if (detail) setSettings({ name: detail.org.name, displayName: detail.org.branding?.displayName ?? '', accentColor: detail.org.branding?.accentColor ?? '#8266f2' }); }, [detail]);

  async function run<T>(action: () => Promise<T>, done?: string) {
    setBusy(true); setError(''); setNotice('');
    try { const out = await action(); if (done) setNotice(done); await Promise.all([load(), loadMembers()]); return out; }
    catch (e) { setError((e as Error).message); return undefined; }
    finally { setBusy(false); }
  }
  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 512 * 1024) { setError('Use a CSV file under 512 KB.'); return; }
    setCsv(await file.text());
  }
  const cohortNames = useMemo(() => new Map((detail?.cohorts ?? []).map(c => [c.id, c.name])), [detail]);

  if (!detail) return loadError ? <div className="alert error" role="alert">{loadError} <Link to="/campus">Back to Campus</Link></div> : <LoadingScreen/>;
  if (!staff) return <div className="alert warning">This dashboard is for the placement office. <Link to="/campus">See your assignments</Link></div>;
  return <div className="page-enter org-page">
    <Link to="/campus" className="back-link"><ArrowLeft size={16}/> Campus</Link>
    <OrgHeading detail={detail}><p>{detail.members} {detail.members === 1 ? 'member' : 'members'} · {detail.invitations} pending {detail.invitations === 1 ? 'invitation' : 'invitations'} · {detail.cohorts.length} {detail.cohorts.length === 1 ? 'cohort' : 'cohorts'}</p></OrgHeading>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}

    <div className="org-grid">
      <section className="card campus-card"><h2><Users size={18}/> Join code</h2>
        <p className="muted">Students enter a code on their Campus page and see exactly what you will see before they join. This code adds them with no cohort; each cohort's own code (on its page) places them straight into it.</p>
        <div className="join-code"><code data-testid="join-code">{detail.org.joinCode}</code>
          <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(detail.org.joinCode ?? '').then(() => setNotice('Join code copied.'))}><Copy size={15}/> Copy</button>
          {admin && <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm('Make a new code? The current code stops working; current members stay.')) void run(() => api(`/orgs/${orgId}/join-code`, { method: 'POST' }), 'New join code made.'); }}><RefreshCw size={15}/> New code</button>}</div>
      </section>

      <section className="card campus-card"><h2><ListChecks size={18}/> Cohorts</h2>
        {detail.cohorts.length ? <ul className="campus-list">{detail.cohorts.map(c => <li key={c.id}><div><b>{c.name}</b><span>{c.students} {c.students === 1 ? 'student' : 'students'} · code {c.joinCode}</span></div>
          <Link className="button secondary" to={`/org/${orgId}/cohorts/${c.id}`}>Open <ChevronRight size={15}/></Link></li>)}</ul> : <p className="muted">No cohorts yet. Create one, or import students with a cohort column.</p>}
        <form className="campus-create" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/orgs/${orgId}/cohorts`, { method: 'POST', body: JSON.stringify({ name: cohortName }) }), 'Cohort created.').then(() => setCohortName('')); }}>
          <label className="field">New cohort<input value={cohortName} onChange={e => setCohortName(e.target.value)} minLength={2} maxLength={80} placeholder="For example CSE 2027" required/></label>
          <button className="button primary" disabled={busy}><Plus size={15}/> Add</button></form>
      </section>
    </div>

    <section className="card campus-card"><h2><FileSpreadsheet size={18}/> Import students</h2>
      <p className="muted">Paste or choose a CSV with an <code>email</code> column and, optionally, <code>name</code>, <code>cohort</code>, <code>roll_number</code> and <code>role</code> (student{admin ? ' or coordinator' : ''}). Each person gets an invitation on their Campus page when they sign in with that email; cohorts are created as needed. People who are already members are moved into the cohort.</p>
      <textarea className="csv-input" value={csv} onChange={e => setCsv(e.target.value)} rows={6} placeholder={CSV_EXAMPLE} aria-label="CSV"/>
      <div className="button-row"><label className="button secondary file-button"><Upload size={15}/> Choose file<input type="file" accept=".csv,text/csv" onChange={e => void readFile(e)} hidden/></label>
        <button className="button primary" disabled={busy || !csv.trim()} onClick={() => void run(() => api<ImportResult>(`/orgs/${orgId}/invitations/import`, { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })).then(r => { if (r) { setImported(r); setCsv(''); } })}>Import</button></div>
      {imported && <div className="import-result" role="status"><p><CheckCircle2 size={15}/> {imported.invited} invited, {imported.updated} invitations updated, {imported.alreadyMembers} already members, {imported.cohortsCreated} cohorts created.</p>
        {imported.errors.length > 0 && <ul>{imported.errors.slice(0, 50).map(e => <li key={e.line}>Line {e.line}: {e.error}</li>)}{imported.errors.length > 50 && <li>and {imported.errors.length - 50} more</li>}</ul>}</div>}
    </section>

    <section className="card campus-card"><h2><Users size={18}/> Members</h2>
      {!members ? <p className="muted">Loading…</p> : <div className="table-scroll"><table className="report-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Roll number</th><th>Cohorts</th>{admin && <th/>}</tr></thead>
        <tbody>{members.members.map(m => <tr key={m.userId}><td>{m.name ?? 'Deleted account'}</td><td>{m.email}</td>
          <td>{admin ? <select aria-label={`Role of ${m.name}`} value={m.role} disabled={busy} onChange={e => void run(() => api(`/orgs/${orgId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value as OrgRole }) }), 'Role changed.')}>
            {(m.role === 'student' ? ['admin', 'coordinator', 'student'] as const : ['admin', 'coordinator'] as const).map(r => <option key={r} value={r}>{ORG_ROLE_LABELS[r]}</option>)}</select> : ORG_ROLE_LABELS[m.role]}</td>
          <td>{m.rollNumber}</td>
          <td>{admin && m.role === 'student' ? <select aria-label={`Cohort of ${m.name}`} value={m.cohortIds[0] ?? ''} disabled={busy} onChange={e => void run(() => api(`/orgs/${orgId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ cohortIds: e.target.value ? [e.target.value] : [] }) }), 'Cohort changed.')}>
            <option value="">No cohort</option>{detail.cohorts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : m.cohortIds.map(id => cohortNames.get(id)).filter(Boolean).join(', ')}</td>
          {admin && <td>{m.role !== 'admin' && <button className="icon-button" aria-label={`Remove ${m.name}`} disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.name} from ${detail.org.name}?`)) void run(() => api(`/orgs/${orgId}/members/${m.userId}`, { method: 'DELETE' }), 'Member removed.'); }}><Trash2 size={15}/></button>}</td>}
        </tr>)}</tbody></table></div>}
      {members && members.invitations.length > 0 && <><h3>Pending invitations</h3><div className="table-scroll"><table className="report-table"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Cohort</th><th>Roll number</th><th/></tr></thead>
        <tbody>{members.invitations.map(i => <tr key={i.id}><td>{i.email}</td><td>{i.name}</td><td>{ORG_ROLE_LABELS[i.role]}</td><td>{i.cohortId ? cohortNames.get(i.cohortId) : ''}</td><td>{i.rollNumber}</td>
          <td><button className="icon-button" aria-label={`Cancel invitation for ${i.email}`} disabled={busy} onClick={() => void run(() => api(`/orgs/${orgId}/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation cancelled.')}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div></>}
    </section>

    {admin && <section className="card campus-card"><h2><Settings size={18}/> Settings</h2>
      <form className="form-stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/orgs/${orgId}`, { method: 'PATCH', body: JSON.stringify({ name: settings.name, branding: { ...(settings.displayName.trim() ? { displayName: settings.displayName.trim() } : {}), accentColor: settings.accentColor } }) }), 'Settings saved.'); }}>
        <label className="field">Organisation name<input value={settings.name} onChange={e => setSettings({ ...settings, name: e.target.value })} minLength={2} maxLength={120} required/></label>
        <label className="field">Name shown to students (optional)<input value={settings.displayName} onChange={e => setSettings({ ...settings, displayName: e.target.value })} maxLength={60}/></label>
        <label className="field color-field">Accent colour<input type="color" value={settings.accentColor} onChange={e => setSettings({ ...settings, accentColor: e.target.value })}/></label>
        <button className="button primary" disabled={busy}>Save</button></form>
      <div className="danger-zone"><h3>Delete organisation</h3><p className="muted">Removes the organisation, its cohorts, assignments, invitations and memberships. Students keep all of their own practice.</p>
        <label className="field">Type the organisation name to confirm<input value={confirmName} onChange={e => setConfirmName(e.target.value)}/></label>
        <button className="button secondary danger" disabled={busy || confirmName !== detail.org.name} onClick={() => void run(() => api(`/orgs/${orgId}`, { method: 'DELETE' })).then(r => { if (r) { window.dispatchEvent(new Event('orgs-changed')); navigate('/campus'); } })}><Trash2 size={15}/> Delete</button></div>
    </section>}
    {!admin && <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm(`Leave ${detail.org.name}?`)) void run(() => api(`/orgs/${orgId}/membership`, { method: 'DELETE' })).then(r => { if (r) { window.dispatchEvent(new Event('orgs-changed')); navigate('/campus'); } }); }}>Leave organisation</button>}
  </div>;
}

type SpecDraft = { kind: AssignmentSpec['kind']; type: InterviewType; topic: string; difficulty: 'Beginner' | 'Intermediate' | 'Advanced'; totalQuestions: number; style: InterviewStyle; problemId: string; promptId: string };
const TOPICS = ['DSA', 'React', 'Node.js', 'DBMS'];
function toSpec(d: SpecDraft): AssignmentSpec {
  if (d.kind === 'coding') return { kind: 'coding', problemId: d.problemId };
  if (d.kind === 'design') return { kind: 'design', promptId: d.promptId };
  return { kind: 'interview', type: d.type, topic: d.type === 'Technical' ? d.topic : d.type === 'Behavioral' ? 'Behavioral' : 'General', difficulty: d.difficulty, totalQuestions: d.totalQuestions, ...(d.style !== 'general' ? { style: d.style } : {}) };
}
function describe(spec: AssignmentSpec) {
  if (spec.kind === 'interview') return `${spec.type}${spec.type === 'Technical' ? ` · ${spec.topic}` : ''} · ${spec.difficulty} · ${spec.totalQuestions} questions${spec.style ? ` · ${STYLE_LABELS[spec.style]}` : ''}`;
  return spec.kind === 'coding' ? spec.problemId : spec.promptId;
}

// One cohort: readiness, assignments and per-student progress, with a CSV export.
export function CohortPage() {
  const { orgId = '', cohortId = '' } = useParams();
  const { detail } = useOrg(orgId);
  const [report, setReport] = useState<CohortReport | null>(null); const [packs, setPacks] = useState<DrivePack[]>([]);
  const [problems, setProblems] = useState<CodingProblemSummary[]>([]); const [prompts, setPrompts] = useState<DesignPromptSummary[]>([]);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(''); const [dueAt, setDueAt] = useState(() => localDateTime(new Date(Date.now() + 7 * 86_400_000)));
  const [draft, setDraft] = useState<SpecDraft>({ kind: 'interview', type: 'Technical', topic: 'DSA', difficulty: 'Intermediate', totalQuestions: 3, style: 'general', problemId: '', promptId: '' });
  const [packId, setPackId] = useState(''); const [packStart, setPackStart] = useState(() => localDateTime(new Date()));

  const load = useCallback(async () => { try { setReport(await api<CohortReport>(`/orgs/${orgId}/cohorts/${cohortId}`)); } catch (e) { setError((e as Error).message); } }, [orgId, cohortId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<OrgOverview>('/orgs').then(d => { setPacks(d.packs); setPackId(d.packs[0]?.id ?? ''); }).catch(() => {});
    api<{ problems: CodingProblemSummary[] }>('/coding/problems').then(d => { setProblems(d.problems); setDraft(x => ({ ...x, problemId: x.problemId || d.problems[0]?.id || '' })); }).catch(() => {});
    api<{ prompts: DesignPromptSummary[] }>('/design/prompts').then(d => { setPrompts(d.prompts); setDraft(x => ({ ...x, promptId: x.promptId || d.prompts[0]?.id || '' })); }).catch(() => {});
  }, []);
  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(done); await load(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  const summary = useMemo(() => {
    if (!report) return null;
    const scored = report.students.filter(s => s.readiness !== null);
    return { students: report.students.length, avg: scored.length ? Math.round(scored.reduce((n, s) => n + s.readiness!, 0) / scored.length) : null,
      active: report.students.filter(s => s.lastActive && Date.now() - new Date(s.lastActive).getTime() < 7 * 86_400_000).length };
  }, [report]);

  if (!report || !summary) return error ? <div className="alert error" role="alert">{error} <Link to={`/org/${orgId}`}>Back</Link></div> : <LoadingScreen/>;
  const defaultTitle = draft.kind === 'coding' ? `Coding: ${problems.find(p => p.id === draft.problemId)?.title ?? ''}` : draft.kind === 'design' ? `System design: ${prompts.find(p => p.id === draft.promptId)?.title ?? ''}`
    : `${draft.type === 'Technical' ? draft.topic : draft.type} interview`;
  return <div className="page-enter org-page cohort-page">
    <Link to={`/org/${orgId}`} className="back-link"><ArrowLeft size={16}/> {detail?.org.name ?? 'Organisation'}</Link>
    <div className="page-heading"><div><span className="eyebrow"><Users size={14}/> COHORT</span><h1>{report.cohort.name}</h1>
      <p>{summary.students} {summary.students === 1 ? 'student' : 'students'} · {summary.active} active in the last 7 days · average readiness {pct(summary.avg)}</p></div>
      <a className="button secondary" href={`/api/orgs/${orgId}/cohorts/${cohortId}/export.csv`}><Download size={15}/> Export CSV</a></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}

    <section className="card campus-card"><h2><Users size={18}/> Cohort join code</h2>
      <p className="muted">Share this with the class: students who join with it are placed in {report.cohort.name}.</p>
      <div className="join-code"><code data-testid="cohort-join-code">{report.cohort.joinCode}</code>
        <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(report.cohort.joinCode).then(() => setNotice('Join code copied.'))}><Copy size={15}/> Copy</button>
        <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm('Make a new code? The current code stops working; current members stay.')) void run(() => api(`/orgs/${orgId}/cohorts/${cohortId}/join-code`, { method: 'POST' }), 'New join code made.'); }}><RefreshCw size={15}/> New code</button></div>
    </section>

    <section className="card campus-card"><h2><Gauge size={18}/> Readiness</h2>
      <p className="muted">The readiness index (0–100) combines skill readiness from adaptive practice (50%), assignments finished on time out of those already due (30%) and the average of the last five AI-scored interviews (20%). Parts without data are left out and the rest reweighted. It is a practice signal for coaching, not a hiring prediction.</p>
      {report.students.length ? <div className="table-scroll"><table className="report-table cohort-table"><thead><tr><th>Student</th><th>Roll</th><th>Readiness</th><th>Skills</th><th>On time</th><th>Interviews</th><th>Last active</th>
        {report.assignments.map(a => <th key={a.id} title={a.title}>{a.title.length > 18 ? a.title.slice(0, 17) + '…' : a.title}</th>)}</tr></thead>
        <tbody>{report.students.map(s => <tr key={s.userId}><td><b>{s.name}</b><br/><span className="muted">{s.email}</span></td><td>{s.rollNumber}</td>
          <td><span className="readiness-chip">{pct(s.readiness)}</span></td><td>{pct(s.parts.skills)}</td><td>{s.parts.assignments === null ? '—' : `${s.parts.assignments}%`}</td><td>{pct(s.parts.interviews)}</td>
          <td>{s.lastActive ? day(s.lastActive) : 'Never'}</td>
          {s.assignments.map(a => <td key={a.id} className={a.done ? (a.late ? 'cell-late' : 'cell-done') : ''}>{a.done ? `${a.late ? 'Late' : 'Done'}${a.score !== null ? ` · ${a.score}` : ''}` : '—'}</td>)}</tr>)}</tbody></table></div>
        : <p className="muted">No students in this cohort yet. Share the cohort join code above, or import students from the organisation page.</p>}
    </section>

    <section className="card campus-card"><h2><ListChecks size={18}/> Assignments</h2>
      {report.assignments.length ? <ul className="campus-list">{report.assignments.map(a => <li key={a.id}><div><b>{a.title}</b><span>{KIND[a.spec.kind]} · {describe(a.spec)} · due {day(a.dueAt)}{a.pack ? ' · pack' : ''}</span></div>
        <div className="assignment-state"><span className="due-chip">{a.completed}/{a.total} done · {a.onTime} on time</span>
          <button className="icon-button" aria-label={`Delete ${a.title}`} disabled={busy} onClick={() => { if (window.confirm(`Delete "${a.title}"?`)) void run(() => api(`/orgs/${orgId}/assignments/${a.id}`, { method: 'DELETE' }), 'Assignment deleted.'); }}><Trash2 size={15}/></button></div></li>)}</ul>
        : <p className="muted">No assignments yet.</p>}
      <h3>New assignment</h3>
      <form className="assignment-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/orgs/${orgId}/cohorts/${cohortId}/assignments`, { method: 'POST', body: JSON.stringify({ title: title.trim() || defaultTitle, spec: toSpec(draft), dueAt: new Date(dueAt).toISOString() }) }), 'Assignment added.').then(ok => { if (ok) setTitle(''); }); }}>
        <label className="field">Kind<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as SpecDraft['kind'] })}><option value="interview">Interview</option><option value="coding">Coding problem</option><option value="design">System design</option></select></label>
        {draft.kind === 'interview' && <>
          <label className="field">Type<select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as InterviewType })}>{(['Technical', 'Behavioral', 'HR'] as const).map(t => <option key={t}>{t}</option>)}</select></label>
          {draft.type === 'Technical' && <label className="field">Topic<select value={draft.topic} onChange={e => setDraft({ ...draft, topic: e.target.value })}>{TOPICS.map(t => <option key={t}>{t}</option>)}</select></label>}
          <label className="field">Level<select value={draft.difficulty} onChange={e => setDraft({ ...draft, difficulty: e.target.value as SpecDraft['difficulty'] })}>{(['Beginner', 'Intermediate', 'Advanced'] as const).map(t => <option key={t}>{t}</option>)}</select></label>
          <label className="field">Questions<select value={draft.totalQuestions} onChange={e => setDraft({ ...draft, totalQuestions: Number(e.target.value) })}>{[2, 3, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="field">Style<select value={draft.style} onChange={e => setDraft({ ...draft, style: e.target.value as InterviewStyle })}>{(Object.keys(STYLE_LABELS) as InterviewStyle[]).map(s => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}</select></label></>}
        {draft.kind === 'coding' && <label className="field wide">Problem<select value={draft.problemId} onChange={e => setDraft({ ...draft, problemId: e.target.value })}>{problems.map(p => <option key={p.id} value={p.id}>{p.title} ({p.difficulty})</option>)}</select></label>}
        {draft.kind === 'design' && <label className="field wide">Problem<select value={draft.promptId} onChange={e => setDraft({ ...draft, promptId: e.target.value })}>{prompts.map(p => <option key={p.id} value={p.id}>{p.title} ({p.difficulty})</option>)}</select></label>}
        <label className="field wide">Title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder={defaultTitle}/></label>
        <label className="field">Due<input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} required/></label>
        <button className="button primary" disabled={busy}><Plus size={15}/> Add assignment</button>
      </form>
      <p className="campus-note">Interviews count when a student finishes one of the same type, topic and level with AI feedback after the assignment is set. Coding counts an accepted submission; system design counts a reviewed design.</p>
    </section>

    {packs.length > 0 && <section className="card campus-card"><h2><Package size={18}/> Drive-preparation packs</h2>
      <p className="muted">A pack adds a sequence of assignments, each due a set number of days after the start.</p>
      <div className="pack-grid">{packs.map(p => <label key={p.id} className={`pack-option ${packId === p.id ? 'active' : ''}`}><input type="radio" name="pack" value={p.id} checked={packId === p.id} onChange={() => setPackId(p.id)}/>
        <b>{p.title}</b><span>{p.description}</span><ol>{p.items.map(i => <li key={i.title}>{i.title} <em>day {i.offsetDays}</em></li>)}</ol></label>)}</div>
      <form className="campus-create" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/orgs/${orgId}/cohorts/${cohortId}/packs`, { method: 'POST', body: JSON.stringify({ packId, startAt: new Date(packStart).toISOString() }) }), 'Pack added.'); }}>
        <label className="field">Start<input type="datetime-local" value={packStart} onChange={e => setPackStart(e.target.value)} required/></label>
        <button className="button primary" disabled={busy || !packId}><Package size={15}/> Add pack</button></form>
    </section>}
  </div>;
}
