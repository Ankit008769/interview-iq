import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, AudioLines, CheckCircle2, FileText, Languages, ListChecks, Sparkles } from 'lucide-react';
import { api } from '../lib/api';

// Shown when the server offers AI interviews, so the AI features are visible right after signing in.
export function WhatsNew() {
  const [state, setState] = useState<{ voice: boolean; accepted: boolean; changed: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api<{ mode: string; transcription?: boolean }>('/interviews/mode'), api<{ disclosure: unknown; accepted: boolean; hasGrant: boolean }>('/account/ai-consent')])
      .then(([mode, consent]) => { if (live && mode.mode === 'ai' && consent.disclosure) setState({ voice: !!mode.transcription, accepted: consent.accepted, changed: consent.hasGrant && !consent.accepted }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!state) return null;
  const features = [
    { icon: <ListChecks size={18}/>, title: 'A verdict for every answer', text: 'Correct, partly correct or not answered, what a strong answer covers, one tip, and an overall score.' },
    { icon: <Languages size={18}/>, title: 'Hindi and Hinglish (beta)', text: 'Choose the interview language in setup; questions and feedback follow it.' },
    ...(state.voice ? [{ icon: <AudioLines size={18}/>, title: 'Answer by voice', text: 'Speak your answer; it is transcribed on our server, then you review the text. Pace and filler-word feedback included.' }] : []),
    { icon: <FileText size={18}/>, title: 'Tailor to your resume, a JD or your code', text: 'Add them under Resume & code: choose a resume or JD in setup, or upload a project for a project-defense interview.' },
    { icon: <Sparkles size={18}/>, title: 'STAR checks and stronger versions', text: 'For finished AI interviews: see which STAR parts you covered and a rewrite built from your own words.' },
  ];
  return <section className="card whats-new" aria-label="New in AI interviews">
    <div className="whats-new-head"><div><span className="eyebrow"><Sparkles size={14}/> NEW IN AI INTERVIEWS</span>
      <p className="whats-new-status">{state.accepted ? <><CheckCircle2 size={15}/> AI permission accepted — these are ready to use.</> : state.changed ? 'AI processing changed (voice answers were added). Accept the updated AI permission in setup to keep using these.' : 'Accept AI permission in setup to use these.'}</p></div>
      <Link to="/interview/new" className="button primary">Start an AI interview <ArrowRight size={16}/></Link></div>
    <ul className="whats-new-list">{features.map(f => <li key={f.title}><span className="whats-new-icon">{f.icon}</span><div><b>{f.title}</b><p>{f.text}</p></div></li>)}</ul>
    <p className="whats-new-note">Scoring runs on our own server and takes a few minutes after your last answer; you can leave and come back.</p>
  </section>;
}
