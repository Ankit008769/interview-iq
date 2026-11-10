import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FolderGit2, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, api, type ProjectDetail, type ProjectSummary } from '../lib/api';

// Uploads go as the raw zip body; the server reads it in memory, removes secrets and never runs the code.
export async function uploadProject(name: string, file: File): Promise<ProjectDetail> {
  const response = await fetch('/api/projects', { method: 'POST', body: file, credentials: 'include',
    headers: { 'Content-Type': 'application/zip', 'x-project-name': encodeURIComponent(name) } });
  let data: { project?: ProjectDetail; error?: string };
  try { data = await response.json(); } catch { throw new Error('Server returned an invalid response.'); }
  if (!response.ok || !data.project) throw new ApiError(data.error || `Upload failed (${response.status}).`, response.status);
  return data.project;
}

export const secretSummary = (p: ProjectSummary) => p.secrets.length + p.secretFiles.length;

export function ProjectsSection() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [name, setName] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirming, setConfirming] = useState<string | null>(null);
  const load = () => api<{ projects: ProjectSummary[] }>('/projects').then(d => setProjects(d.projects)).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  async function upload(e: FormEvent) {
    e.preventDefault(); if (!file) return;
    setBusy(true); setError('');
    try { const project = await uploadProject(name.trim(), file); navigate(`/projects/${project.id}`); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError('');
    try { await api(`/projects/${id}`, { method: 'DELETE' }); setConfirming(null); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const full = !!projects && projects.length >= 3;
  return <>
    <section className="account-card" aria-label="Add a code project"><h2><FolderGit2 size={18}/> Add a code project</h2>
      <p>Upload a project you built as a .zip (up to 8 MB) for a project-defense interview: questions about your own files and functions, and a check of your resume's claims against the code. Dependency and build folders are skipped. Files that usually hold credentials (such as <code>.env</code> or key files) are dropped and secrets found in the code are removed before anything is saved. Your code is never run.</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      <form className="form-stack project-form" onSubmit={upload}>
        <label className="field">Project name<input value={name} onChange={e => setName(e.target.value)} required maxLength={80} placeholder="e.g. Campus chat app"/></label>
        <label className="field">Zip file<input type="file" accept=".zip,application/zip" onChange={e => setFile(e.target.files?.[0] ?? null)} required/></label>
        <button className="button primary" disabled={busy || full || !file || !name.trim()}>{busy ? 'Reading your code…' : 'Upload project'}</button>
        {full && <p>You have 3 projects, the maximum. Delete one to add another.</p>}
      </form></section>
    <section className="account-card" aria-label="Your code projects"><h2>Your code projects</h2>
      {!projects ? <p>Loading your projects…</p> : !projects.length ? <p>No projects yet.</p>
        : <ul className="document-list">{projects.map(p => <li key={p.id}>
          <div className="document-row"><FolderGit2 size={18} aria-hidden="true"/><div className="document-meta"><b><Link to={`/projects/${p.id}`}>{p.name}</Link></b>
            <span>{p.stats.files} files · {p.stats.lines.toLocaleString()} lines · {p.stats.symbols} functions and classes · {p.stats.languages.slice(0, 3).map(l => l.language).join(', ')}{p.deleting ? ' · Deletion not finished' : ''}</span>
            {secretSummary(p) > 0 && <span className="secret-note"><ShieldAlert size={13}/> {secretSummary(p)} secret{secretSummary(p) === 1 ? '' : 's'} removed: rotate them</span>}</div>
            <div className="document-actions"><Link className="button secondary" to={`/projects/${p.id}`}>Open</Link>
              <button type="button" className="button secondary" aria-label={`Delete ${p.name}`} disabled={busy} onClick={() => setConfirming(p.id)}><Trash2 size={15}/> Delete</button></div></div>
          {confirming === p.id && <div className="document-confirm" role="alert"><p>Delete “{p.name}”? Interview questions generated from it are removed too. Your answers stay.</p>
            <button type="button" className="button primary" disabled={busy} onClick={() => remove(p.id)}>Delete project and its questions</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button></div>}
        </li>)}</ul>}
    </section>
  </>;
}
