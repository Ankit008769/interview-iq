import { AIConsent } from '../components/AIConsent';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BrainCircuit, Check, CircleHelp, Clock3, FileText, MessageCircle, Sparkles, Target } from 'lucide-react';
import { api, LANGUAGE_LABELS, STYLE_LABELS, warmUpAI, type CandidateDocument, type Interview, type InterviewLanguage, type InterviewStyle, type Mode } from '../lib/api';
const types=['Technical','Behavioral','HR'] as const;
const topics=['DSA','React','Node.js','DBMS','Behavioral','General'];
const difficulties=['Beginner','Intermediate','Advanced'] as const;
export function Setup() {
  const navigate=useNavigate(); const [params]=useSearchParams();
  const initialType=types.includes(params.get('type') as typeof types[number])?params.get('type') as typeof types[number]:'Technical';
  const [role,setRole]=useState('Software Development Engineer');
  const [type,setType]=useState<typeof types[number]>(initialType);
  const [difficulty,setDifficulty]=useState<typeof difficulties[number]>('Intermediate');
  const [topic,setTopic]=useState(params.get('topic')||'DSA');
  const [totalQuestions,setTotalQuestions]=useState(3);
  const [timeLimit,setTimeLimit]=useState<number|null>(null);
  const [loading,setLoading]=useState(false); const [error,setError]=useState('');
  const [consented,setConsented]=useState(false);const [aiAvailable,setAIAvailable]=useState(false);const [useAI,setUseAI]=useState(true);
  // AI is the default whenever the server offers it; untick for a practice interview from the curated bank.
  const aiOn=useAI&&aiAvailable;
  // Documents tailor AI questions only; practice mode uses the curated bank.
  const [documents,setDocuments]=useState<CandidateDocument[]|null>(null);const [resumeId,setResumeId]=useState('');const [jdId,setJdId]=useState('');
  useEffect(()=>{if(!aiOn||documents)return;api<{documents:CandidateDocument[]}>('/documents').then(d=>setDocuments(d.documents.filter(x=>!x.deleting))).catch(()=>setDocuments([]));},[aiOn,documents]);
  const documentIds=aiOn?[resumeId,jdId].filter(Boolean):[];
  // Practice questions come from the English bank; Hindi and Hinglish need the AI interviewer.
  const [language,setLanguage]=useState<InterviewLanguage>('en');
  const chosenLanguage:InterviewLanguage=aiOn?language:'en';
  // Styles shape AI questions like a kind of employer; practice interviews use the general bank.
  const [style,setStyle]=useState<InterviewStyle>('general');
  const chosenStyle:InterviewStyle=aiOn?style:'general';
  async function create(e:FormEvent) {e.preventDefault();setLoading(true);setError('');
    try {const d=await api<{interview:Interview;mode:Mode}>('/interviews',{method:'POST',body:JSON.stringify({mode:aiOn?'ai':'practice',role,type,difficulty,topic: type==='Technical'?topic:type==='Behavioral'?'Behavioral':'General',totalQuestions,...(timeLimit?{timeLimitSeconds:timeLimit}:{}),...(documentIds.length?{documentIds}:{}),...(chosenLanguage!=='en'?{language:chosenLanguage}:{}),...(chosenStyle!=='general'?{style:chosenStyle}:{})}),timeoutMs:180_000});navigate(`/interview/${d.interview._id}`);}
    catch(err){setError((err as Error).message);}finally{setLoading(false);}
  }
  return <div className="page-enter setup-page"><Link to="/dashboard" className="back-link"><ArrowLeft size={16}/> Back to dashboard</Link><div className="page-heading"><div><span className="eyebrow"><Sparkles size={14}/> PERSONALIZE YOUR EXPERIENCE</span><h1>Set up your interview</h1><p>Tell us what you'd like to practice. We'll tailor the session to you.</p></div></div>
    <div className="setup-grid"><form className="card setup-form" onSubmit={create}>
      <div className="setup-label"><span className="num-pill">01</span><div><h3>What role are you preparing for?</h3><p>We'll tailor questions to this position.</p></div></div>
      <label className="field">Target job role<input value={role} onChange={e=>setRole(e.target.value)} required maxLength={100}/></label>
      <div className="line"/>
      <div className="setup-label"><span className="num-pill">02</span><div><h3>Select interview type</h3><p>What area would you like to focus on?</p></div></div>
      <div className="select-grid">{types.map(v=><button type="button" key={v} onClick={()=>setType(v)} className={`choice ${type===v?'selected':''}`}><span className="choice-symbol">{v==='Technical'?<BrainCircuit size={20}/>:v==='HR'?<MessageCircle size={20}/>:<Target size={20}/>}</span><span>{v}</span>{type===v&&<Check size={16} className="choice-check"/>}</button>)}</div>
      {type==='Technical'&&<label className="field top-gap">Primary topic<select value={topic} onChange={e=>setTopic(e.target.value)}>{topics.slice(0,4).map(t=><option key={t}>{t}</option>)}</select></label>}
      <div className="line"/>
      <div className="setup-label"><span className="num-pill">03</span><div><h3>Set the difficulty</h3><p>Choose how challenging the interview should be.</p></div></div>
      <div className="segmented">{difficulties.map(v=><button type="button" key={v} onClick={()=>setDifficulty(v)} className={difficulty===v?'active':''}>{v}</button>)}</div>
      <div className="line"/>
      <div className="setup-label"><span className="num-pill">04</span><div><h3>Session length</h3><p>Start small. You'll build up over time.</p></div></div>
      <div className="segmented count-select">{[2,3,5].map(v=><button type="button" key={v} onClick={()=>setTotalQuestions(v)} className={totalQuestions===v?'active':''}>{v} questions</button>)}</div>
      <div className="line"/>
      <div className="setup-label"><span className="num-pill">05</span><div><h3>Time per question</h3><p>Practise under real interview pressure, or take your time.</p></div></div>
      <div className="segmented timing-select" role="group" aria-label="Time per question">{([null,120,180,300] as const).map(v=><button type="button" key={v??0} aria-pressed={timeLimit===v} onClick={()=>setTimeLimit(v)} className={timeLimit===v?'active':''}>{v?`${v/60} min`:'Untimed'}</button>)}</div>
      <p className="timing-note">{timeLimit?`A countdown runs for each question, up to ${totalQuestions*timeLimit/60} minutes in total. You can pause it, and you can still submit after time runs out; your results show how long each answer took.`:'No countdown. Your results still show how long each answer took.'}</p>
      <div className="line"/><AIConsent onChange={(ready,available)=>{setConsented(ready);setAIAvailable(available);if(available)warmUpAI();}}/>
      {aiAvailable&&<label className="consent-check"><input type="checkbox" checked={useAI} onChange={e=>setUseAI(e.target.checked)}/> Use AI for this interview (requires permission above)</label>}
      {aiOn&&!consented&&<p className="ai-needed" role="status">Accept AI processing above to start an AI interview with fresh questions, verdicts and tips, Hindi or Hinglish, voice answers and resume tailoring. Or untick Use AI for a practice interview.</p>}
      {aiOn&&<div className="language-box"><h3>Interview language</h3>
        <div className="segmented language-select" role="group" aria-label="Interview language">{(['en','hi','hinglish'] as const).map(v=><button type="button" key={v} aria-pressed={language===v} onClick={()=>setLanguage(v)} className={language===v?'active':''}>{LANGUAGE_LABELS[v]}</button>)}</div>
        <p className="timing-note">{language==='en'?'Questions and feedback in English.':language==='hi'?'Beta: questions and feedback in Hindi (Devanagari). Answer in Hindi, English or a mix; technical terms stay in English. Hindi from the current model can sound unnatural, and scoring is slower.':'Beta: questions and feedback in Hinglish (Roman script). Answer in Hindi, English or a mix. Scoring of mixed-language answers is less accurate than English.'}</p></div>}
      {aiOn&&<div className="style-box"><h3>Interview style</h3>
        <div className="segmented style-select" role="group" aria-label="Interview style">{(['general','product','services','startup'] as const).map(v=><button type="button" key={v} aria-pressed={style===v} onClick={()=>setStyle(v)} className={style===v?'active':''}>{STYLE_LABELS[v]}</button>)}</div>
        <p className="timing-note">{style==='general'?'A balanced interview for the role and topic.':style==='product'?'Deeper follow-ups on how and why, design choices, scale and trade-offs.':style==='services'?'Fundamentals: clear definitions, core concepts, standard problems and communication.':'Practical ownership: shipping under constraints, debugging and breadth across the stack.'} Styles describe a kind of employer; they do not copy any real company's questions.</p></div>}
      {aiOn&&<div className="tailor-box"><h3><FileText size={17}/> Tailor to your resume or a job description <span>(optional)</span></h3>
        {documents===null?<p>Loading your documents…</p>:!documents.length?<p>Add a resume or job description to get questions about your own projects and the role. <Link to="/documents">Add one</Link></p>:<>
          <div className="tailor-grid"><label className="field">Resume<select value={resumeId} onChange={e=>setResumeId(e.target.value)}><option value="">None</option>{documents.filter(d=>d.kind==='resume').map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
          <label className="field">Job description<select value={jdId} onChange={e=>setJdId(e.target.value)}><option value="">None</option>{documents.filter(d=>d.kind==='job_description').map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label></div>
          <p className="timing-note">{documentIds.length?'The full text of the chosen documents is sent with each question request. Each tailored question shows the line it came from.':'No document chosen: questions follow the role and topic only.'} <Link to="/documents">Manage documents</Link></p></>}
      </div>}
      <p>{aiOn?'AI interview selected.':'Practice selected: curated questions, no AI scoring.'}</p>
      {error&&<div className="alert error" role="alert">{error}</div>}
      <button type="submit" className="button primary full start-btn" disabled={loading || (aiOn && !consented)}>{loading?(aiOn?'Writing your first question… this can take a minute or two if the AI model was idle':'Preparing your interview...'):'Start interview'} <ArrowRight size={18}/></button>
    </form><aside className="setup-aside"><div className="card info-card"><span className="info-icon"><Sparkles size={22}/></span><h3>What to expect</h3><div className="info-row"><Target size={18}/><span>Questions matched to your role and level</span></div><div className="info-row"><MessageCircle size={18}/><span>Follow-up questions based on your responses with AI enabled</span></div><div className="info-row"><Clock3 size={18}/><span>Take your time and think through each answer</span></div><div className="info-row"><CircleHelp size={18}/><span>Feedback at the end of your session</span></div></div><div className="hint-box"><BrainCircuit size={18}/><span>Tip: Give specific examples and explain your reasoning, not just the conclusion.</span></div></aside></div>
  </div>;
}
