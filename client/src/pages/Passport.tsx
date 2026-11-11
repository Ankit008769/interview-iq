import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, CircleAlert, Copy, Download, ShieldCheck, ShieldX, Stamp, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { LoadingScreen } from '../components/Layout';

type Kind = 'interviews' | 'skills' | 'coding' | 'design';
interface Record_ {
  interviews?: { completedAiScoredInterviews: number; byType: Record<string, number> } | null;
  skills?: { skills: { skill: string; area: string; level: string; interval: [number, number] }[]; method: string } | null;
  coding?: { problemsSolved: number; byDifficulty: Record<string, number>; method: string } | null;
  design?: { designsReviewed: number; meanRubricScore: number; method: string } | null;
}
interface Overview { configured: boolean; disclaimer: string; available: Record_; issued: { publicId: string; kinds: Kind[]; includeName: boolean; issuedAt: string; validUntil: string; revokedAt: string | null }[] }
const LABEL: Record<Kind, string> = { interviews: 'AI-scored mock interviews', skills: 'Skill levels from adaptive practice', coding: 'Coding problems solved', design: 'System designs reviewed' };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// What a practice record says, in plain words (shared by the holder's page and the public page).
function RecordView({ record }: { record: Record_ }) {
  return <dl className="passport-record">
    {record.interviews && <><dt>{LABEL.interviews}</dt><dd>{record.interviews.completedAiScoredInterviews} completed ({Object.entries(record.interviews.byType).map(([t, n]) => `${t} ${n}`).join(', ')})</dd></>}
    {record.skills && <><dt>{LABEL.skills}</dt><dd><ul>{record.skills.skills.map(s => <li key={`${s.area}${s.skill}`}>{s.area}: {s.skill}, {s.level} (likely {s.interval[0]}–{s.interval[1]} of 5)</li>)}</ul><small>{record.skills.method}</small></dd></>}
    {record.coding && <><dt>{LABEL.coding}</dt><dd>{record.coding.problemsSolved} ({Object.entries(record.coding.byDifficulty).map(([d, n]) => `${d} ${n}`).join(', ')})<br/><small>{record.coding.method}</small></dd></>}
    {record.design && <><dt>{LABEL.design}</dt><dd>{record.design.designsReviewed}, average {record.design.meanRubricScore} of 5<br/><small>{record.design.method}</small></dd></>}
  </dl>;
}

// The holder's page: choose what to share, issue, copy the link, download or revoke.
export function PassportPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [kinds, setKinds] = useState<Kind[]>([]); const [includeName, setIncludeName] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setData(await api<Overview>('/passport')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return error ? <div className="alert error" role="alert">{error}</div> : <LoadingScreen/>;
  const have = (Object.keys(LABEL) as Kind[]).filter(k => data.available[k]);
  const link = (id: string) => `${window.location.origin}/passport/${id}`;
  async function issue() {
    setBusy(true); setError(''); setNotice('');
    try { const r = await api<{ publicId: string }>('/passport', { method: 'POST', body: JSON.stringify({ kinds, includeName }) }); setNotice(`Passport created. Share ${link(r.publicId)}`); setKinds([]); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!window.confirm('Revoke this passport? Anyone with the link will see that it was revoked.')) return;
    try { await api(`/passport/${id}`, { method: 'DELETE' }); setNotice('Passport revoked.'); await load(); } catch (e) { setError((e as Error).message); }
  }
  return <div className="page-enter campus-page passport-page">
    <div className="page-heading"><div><span className="eyebrow"><Stamp size={14}/> SKILL PASSPORT</span><h1>Skill passport</h1>
      <p>A signed record of your practice that you can share with a college or employer, and revoke at any time.</p></div></div>
    <div className="alert warning"><CircleAlert size={16}/> <span>{data.disclaimer}</span></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    {!data.configured && <div className="alert warning">Passports cannot be issued on this server yet.</div>}
    <section className="card campus-card"><h2><BadgeCheck size={18}/> Create a passport</h2>
      {have.length ? <>
        <p className="muted">Choose what to include. Only what you choose is signed into the passport.</p>
        <div className="passport-options">{have.map(k => <label key={k} className="check-row"><input type="checkbox" checked={kinds.includes(k)} onChange={e => setKinds(e.target.checked ? [...kinds, k] : kinds.filter(x => x !== k))}/> {LABEL[k]}</label>)}
          <label className="check-row"><input type="checkbox" checked={includeName} onChange={e => setIncludeName(e.target.checked)}/> Show my name on it</label></div>
        <RecordView record={Object.fromEntries(kinds.map(k => [k, data.available[k]]))}/>
        <button className="button primary" disabled={busy || !kinds.length || !data.configured} onClick={() => void issue()}><Stamp size={15}/> Create passport</button>
      </> : <p className="muted">Nothing to include yet. Complete AI-scored interviews, solve coding problems or get a design reviewed.</p>}
    </section>
    {data.issued.length > 0 && <section className="card campus-card"><h2><ShieldCheck size={18}/> Your passports</h2>
      <ul className="campus-list">{data.issued.map(p => <li key={p.publicId}>
        <div><b>{p.kinds.map(k => LABEL[k]).join(', ')}</b><span>{p.revokedAt ? `Revoked ${day(p.revokedAt)}` : `Issued ${day(p.issuedAt)} · valid until ${day(p.validUntil)}`}{p.includeName ? ' · with your name' : ''}</span></div>
        {!p.revokedAt && <div className="button-row">
          <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(link(p.publicId)).then(() => setNotice('Link copied.'))}><Copy size={15}/> Copy link</button>
          <a className="button secondary" href={`/api/passport/${p.publicId}/credential.json`}><Download size={15}/> JSON</a>
          <button className="icon-button" aria-label="Revoke passport" onClick={() => void revoke(p.publicId)}><Trash2 size={16}/></button></div>}
      </li>)}</ul></section>}
  </div>;
}

interface PublicView { revoked: boolean; disclaimer: string; credential?: { issuer: { name?: string; id: string }; validFrom: string; validUntil: string; credentialSubject: { name?: string; practiceRecord: Record_; asOf: string } };
  verification?: { valid: boolean; checks: { issuer: boolean; signature: boolean; current: boolean; notRevoked: boolean } } }
// Public page behind a shared link: the record, whether it verifies, and what it is not.
export function PublicPassport() {
  const { publicId = '' } = useParams();
  const [data, setData] = useState<PublicView | null>(null); const [error, setError] = useState('');
  useEffect(() => { api<PublicView>(`/passport/public/${publicId}`).then(setData).catch(e => setError((e as Error).message)); }, [publicId]);
  if (!data) return <main className="recovery-page account-card">{error ? <p role="alert">{error}</p> : <p>Loading…</p>}</main>;
  const c = data.credential, v = data.verification;
  return <main className="recovery-page account-card public-passport">
    <h1><Stamp size={22}/> Interview IQ practice record</h1>
    {data.revoked || !c || !v ? <p className="alert error"><ShieldX size={16}/> This passport was revoked by its holder.</p> : <>
      <p className={`passport-verdict ${v.valid ? 'ok' : 'bad'}`} role="status">{v.valid ? <><ShieldCheck size={18}/> Verified: signed by {c.issuer.name ?? c.issuer.id}, unchanged and not revoked.</>
        : <><ShieldX size={18}/> Not valid: {[!v.checks.signature && 'the signature does not match', !v.checks.current && 'it has expired', !v.checks.notRevoked && 'it was revoked', !v.checks.issuer && 'the issuer is unknown'].filter(Boolean).join(', ')}.</>}</p>
      {c.credentialSubject.name && <p><b>Holder:</b> {c.credentialSubject.name}</p>}
      <p className="muted">As of {c.credentialSubject.asOf} · issued {day(c.validFrom)} · valid until {day(c.validUntil)}</p>
      <RecordView record={c.credentialSubject.practiceRecord}/>
    </>}
    <p className="alert warning"><CircleAlert size={16}/> {data.disclaimer}</p>
    <p className="muted">This is a W3C Verifiable Credential with an Ed25519 Data Integrity proof (eddsa-jcs-2022). <Link to="/login">Interview IQ</Link></p>
  </main>;
}
