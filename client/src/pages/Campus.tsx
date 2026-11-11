import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, CalendarClock, CheckCircle2, ChevronRight, CircleAlert, KeyRound, LogOut, Mail, Plus, ShieldCheck } from 'lucide-react';
import { api, ORG_ROLE_LABELS, type MyAssignment, type OrgOverview } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export function dueLabel(a: Pick<MyAssignment, 'dueAt' | 'done' | 'late'>, now = Date.now()) {
  if (a.done) return a.late ? 'Done late' : 'Done';
  const days = Math.ceil((new Date(a.dueAt).getTime() - now) / 86_400_000);
  return days < 0 ? 'Overdue' : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
}
const KIND = { interview: 'Interview', coding: 'Coding', design: 'System design' } as const;

// What a student agrees to share; shown with every way of joining.
function SharingTerms({ text, agreed, onChange }: { text: string; agreed: boolean; onChange: (v: boolean) => void }) {
  return <div className="sharing-terms"><p><ShieldCheck size={16}/> {text}</p>
    <label className="check-row"><input type="checkbox" checked={agreed} onChange={e => onChange(e.target.checked)}/> I agree to share this with the organisation</label></div>;
}

// Campus (roadmap D1): join a college or placement office, see its assignments, or set one up.
export function Campus() {
  const navigate = useNavigate();
  const [data, setData] = useState<OrgOverview | null>(null);
  const [assignments, setAssignments] = useState<MyAssignment[]>([]);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [code, setCode] = useState(''); const [roll, setRoll] = useState(''); const [agreed, setAgreed] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null); const [acceptAgreed, setAcceptAgreed] = useState(false);
  const [orgName, setOrgName] = useState(''); const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overview, mine] = await Promise.all([api<OrgOverview>('/orgs'), api<{ assignments: MyAssignment[] }>('/orgs/assignments')]);
      setData(overview); setAssignments(mine.assignments);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(done); await load(); window.dispatchEvent(new Event('orgs-changed')); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function join(e: FormEvent) {
    e.preventDefault();
    await run(() => api('/orgs/join', { method: 'POST', body: JSON.stringify({ code: code.trim(), sharingVersion: data!.sharing.version, ...(roll.trim() ? { rollNumber: roll.trim() } : {}) }) }), 'You joined the organisation.');
    setCode(''); setRoll(''); setAgreed(false);
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { const d = await api<{ org: { id: string } }>('/orgs', { method: 'POST', body: JSON.stringify({ name: orgName }) }); window.dispatchEvent(new Event('orgs-changed')); navigate(`/org/${d.org.id}`); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }

  if (!data) return error ? <div className="alert error" role="alert">{error}</div> : <LoadingScreen/>;
  const studying = data.memberships.filter(m => m.role === 'student');
  const staff = data.memberships.filter(m => m.role !== 'student');
  return <div className="page-enter campus-page">
    <div className="page-heading"><div><span className="eyebrow"><Building2 size={14}/> CAMPUS</span><h1>Campus</h1>
      <p>Join your college's placement office to get its assignments, or set one up for your students.</p></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}

    {data.invitations.length > 0 && <section className="card campus-card"><h2><Mail size={18}/> Invitations</h2>
      {!data.emailVerified && <div className="alert warning"><CircleAlert size={16}/> <span>Verify your email address on the <Link to="/account">Account</Link> page before accepting an invitation.</span></div>}
      <ul className="campus-list">{data.invitations.map(i => <li key={i.id}>
        <div><b>{i.orgName}</b><span>Invited as {ORG_ROLE_LABELS[i.role].toLowerCase()} · {day(i.createdAt)}</span></div>
        {accepting === i.id ? <div className="campus-accept">
          <SharingTerms text={data.sharing.text} agreed={acceptAgreed} onChange={setAcceptAgreed}/>
          <div className="button-row"><button className="button primary" disabled={busy || !acceptAgreed}
            onClick={() => void run(() => api(`/orgs/invitations/${i.id}/accept`, { method: 'POST', body: JSON.stringify({ sharingVersion: data.sharing.version }) }), `You joined ${i.orgName}.`).then(() => setAccepting(null))}>Accept</button>
            <button className="button secondary" onClick={() => setAccepting(null)}>Cancel</button></div></div>
          : <div className="button-row"><button className="button primary" disabled={!data.emailVerified} onClick={() => { setAccepting(i.id); setAcceptAgreed(false); }}>Review and accept</button>
            <button className="button secondary" disabled={busy} onClick={() => void run(() => api(`/orgs/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation declined.')}>Decline</button></div>}
      </li>)}</ul></section>}

    {studying.length > 0 && <section className="card campus-card"><h2><CalendarClock size={18}/> Assignments</h2>
      {assignments.length ? <ul className="campus-list assignment-list">{assignments.map(a => {
        const label = dueLabel(a);
        return <li key={a.id} className={a.done ? 'done' : label === 'Overdue' ? 'overdue' : ''}>
          <div><b>{a.title}</b><span>{KIND[a.spec.kind]} · {a.orgName} · due {day(a.dueAt)}</span></div>
          <div className="assignment-state"><span className={`due-chip ${a.done ? 'done' : label === 'Overdue' ? 'overdue' : ''}`}>{a.done && <CheckCircle2 size={13}/>} {label}{a.done && a.score !== null ? ` · ${a.score}` : ''}</span>
            {!a.done && <Link className="button secondary" to={a.link}>Start <ChevronRight size={15}/></Link>}</div>
        </li>;
      })}</ul> : <p className="muted">No assignments yet. Your placement office will add them here.</p>}
      <p className="campus-note">An assignment counts as done when you finish it after it was set: an interview of the same type, topic and level with AI feedback, an accepted coding submission, or a reviewed design.</p>
    </section>}

    <section className="card campus-card"><h2><KeyRound size={18}/> Join with a code</h2>
      <form className="form-stack" onSubmit={e => void join(e)}>
        <div className="campus-join-fields"><label className="field">Join code<input value={code} onChange={e => setCode(e.target.value.toUpperCase())} required minLength={6} maxLength={12} placeholder="For example K7Q2M9XD" autoComplete="off"/></label>
          <label className="field">Roll number (optional)<input value={roll} onChange={e => setRoll(e.target.value)} maxLength={40}/></label></div>
        <SharingTerms text={data.sharing.text} agreed={agreed} onChange={setAgreed}/>
        <button className="button primary" disabled={busy || !agreed || code.trim().length < 6}>Join</button>
      </form></section>

    {data.memberships.length > 0 && <section className="card campus-card"><h2><Building2 size={18}/> Your organisations</h2>
      <ul className="campus-list">{[...staff, ...studying].map(m => <li key={m.orgId} style={m.branding?.accentColor ? { borderLeftColor: m.branding.accentColor } : undefined} className="org-row">
        <div><b>{m.branding?.displayName || m.name}</b><span>{ORG_ROLE_LABELS[m.role]}</span></div>
        <div className="button-row">{m.role !== 'student' && <Link className="button secondary" to={`/org/${m.orgId}`}>Open dashboard <ChevronRight size={15}/></Link>}
          {m.role === 'student' && <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm(`Leave ${m.name}? It will stop seeing your progress at once.`)) void run(() => api(`/orgs/${m.orgId}/membership`, { method: 'DELETE' }), `You left ${m.name}.`); }}><LogOut size={15}/> Leave</button>}</div>
      </li>)}</ul></section>}

    <section className="card campus-card"><h2><Plus size={18}/> Set up a placement office</h2>
      <p className="muted">For training and placement officers: create an organisation, import students from a spreadsheet, set assignments and drive-preparation packs, and follow each cohort's readiness. Students choose to join and can leave at any time.</p>
      <form className="campus-create" onSubmit={e => void create(e)}><label className="field">Organisation name<input value={orgName} onChange={e => setOrgName(e.target.value)} required minLength={2} maxLength={120} placeholder="College or department name"/></label>
        <button className="button primary" disabled={busy || orgName.trim().length < 2}>Create</button></form>
    </section>
  </div>;
}
