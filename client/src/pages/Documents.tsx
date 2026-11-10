import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Trash2 } from 'lucide-react';
import { api, type CandidateDocument, type DocumentKind } from '../lib/api';
import { kindLabel } from '../components/Grounding';
import { ProjectsSection } from '../components/Projects';
type Limits = { maxDocuments: number; maxChars: number };
export function Documents() {
  const [documents, setDocuments] = useState<CandidateDocument[]>(); const [limits, setLimits] = useState<Limits>({ maxDocuments: 10, maxChars: 12000 });
  const [kind, setKind] = useState<DocumentKind>('resume'); const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [opened, setOpened] = useState<Record<string, string>>({}); const [confirming, setConfirming] = useState<string | null>(null);
  async function load() {
    try { const d = await api<{ documents: CandidateDocument[]; limits: Limits }>('/documents'); setDocuments(d.documents); setLimits(d.limits); }
    catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { await api('/documents', { method: 'POST', body: JSON.stringify({ kind, title, text }) });
      setTitle(''); setText(''); setMessage(`Saved your ${kindLabel(kind)}.`); await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function toggle(id: string) {
    if (opened[id] !== undefined) { const { [id]: _, ...rest } = opened; setOpened(rest); return; }
    try { const d = await api<{ document: CandidateDocument }>(`/documents/${id}`); setOpened({ ...opened, [id]: d.document.text ?? '' }); }
    catch (err) { setError((err as Error).message); }
  }
  async function remove(doc: CandidateDocument) {
    setBusy(true); setError(''); setMessage('');
    try { await api(`/documents/${doc.id}`, { method: 'DELETE' }); setConfirming(null); setMessage(`Deleted “${doc.title}” and the questions generated from it.`); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const full = !!documents && documents.length >= limits.maxDocuments;
  return <div className="account-page documents-page page-enter"><h1>Resume, job descriptions and code</h1>
    <p>Paste your resume or a job description to get AI interview questions about your own projects and the role's requirements. Each tailored question shows the line it came from. Upload a project's code for a project-defense interview about your own files and functions.</p>
    {error && <div className="alert error" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    <section className="account-card"><h2>Add a document</h2>
      <p>Text only, up to {limits.maxChars.toLocaleString()} characters. Remove your phone number, address and anything else you don't want to share: the full text goes to the AI provider when you choose it for an interview.</p>
      <form className="form-stack document-form" onSubmit={save}>
        <div className="segmented document-kind" role="group" aria-label="Document type">{(['resume', 'job_description'] as const).map(k =>
          <button type="button" key={k} aria-pressed={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{k === 'resume' ? 'Resume' : 'Job description'}</button>)}</div>
        <label className="field">Title<input value={title} onChange={e => setTitle(e.target.value)} required minLength={2} maxLength={80} placeholder={kind === 'resume' ? 'e.g. Resume, October 2026' : 'e.g. Backend engineer at a fintech'}/></label>
        <label className="field">Text<textarea value={text} onChange={e => setText(e.target.value)} required minLength={50} maxLength={limits.maxChars} rows={10} placeholder={kind === 'resume' ? 'Paste your resume text here' : 'Paste the job description here'}/></label>
        <div className="document-form-foot"><span>{text.length.toLocaleString()} / {limits.maxChars.toLocaleString()}</span>
          <button className="button primary" disabled={busy || full || text.trim().length < 50 || title.trim().length < 2}>Save {kindLabel(kind)}</button></div>
        {full && <p>You have {limits.maxDocuments} documents, the maximum. Delete one to add another.</p>}
      </form></section>
    <section className="account-card"><h2>Your documents</h2>
      {!documents ? <p>Loading your documents…</p> : !documents.length ? <p>No documents yet. Once you add one, choose it when you <Link to="/interview/new">set up an AI interview</Link>.</p>
        : <ul className="document-list">{documents.map(doc => <li key={doc.id}>
          <div className="document-row"><FileText size={18} aria-hidden="true"/><div className="document-meta"><b>{doc.title}</b>
            <span>{doc.kind === 'resume' ? 'Resume' : 'Job description'} · {doc.chars.toLocaleString()} characters · Added {new Date(doc.createdAt).toLocaleDateString()}{doc.deleting ? ' · Deletion not finished' : ''}</span></div>
            <div className="document-actions"><button type="button" className="button secondary" aria-expanded={opened[doc.id] !== undefined} onClick={() => toggle(doc.id)}>{opened[doc.id] !== undefined ? 'Hide text' : 'View text'}</button>
              <button type="button" className="button secondary" aria-label={`Delete ${doc.title}`} disabled={busy} onClick={() => setConfirming(doc.id)}><Trash2 size={15}/> Delete</button></div></div>
          {opened[doc.id] !== undefined && <pre className="document-text">{opened[doc.id]}</pre>}
          {confirming === doc.id && <div className="document-confirm" role="alert"><p>Delete “{doc.title}”? Interview questions generated from it are removed too. Your answers stay.</p>
            <button type="button" className="button primary" disabled={busy} onClick={() => remove(doc)}>Delete document and its questions</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button></div>}
        </li>)}</ul>}
    </section>
    <ProjectsSection/>
  </div>;
}
