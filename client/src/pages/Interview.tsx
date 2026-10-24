import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BrainCircuit, CircleCheck, Clock3, Info, Send, Sparkles, UserRound } from 'lucide-react';
import { api, type Interview as InterviewModel, type Mode } from '../lib/api';
import { LoadingScreen } from '../components/Layout';
import { PausedCard, QuestionTimer, clock, useQuestionElapsed } from '../components/Timing';
import { ReadAloud, VoiceAnswer } from '../components/Voice';
type InterviewResponse = { interview: InterviewModel; mode: Mode; serverNow?: string };
export function InterviewRoom() {
  const {id}=useParams();const navigate=useNavigate();
  const [interview,setInterview]=useState<InterviewModel|null>(null);
  const [mode,setMode]=useState<Mode>('practice');
  const [skew,setSkew]=useState(0);
  const [answer,setAnswer]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const apply=(d:InterviewResponse)=>{setInterview(d.interview);setMode(d.mode);if(d.serverNow)setSkew(new Date(d.serverNow).getTime()-Date.now());};
  useEffect(()=>{let live=true;api<InterviewResponse>(`/interviews/${id}`).then(d=>{if(live)apply(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false}},[id]);
  // Voice answers appear only when the server has a transcription model; typing always works.
  const [transcription,setTranscription]=useState(false);
  const [voiceBusy,setVoiceBusy]=useState(false);
  useEffect(()=>{api<{transcription?:boolean}>('/interviews/mode').then(d=>setTranscription(!!d.transcription)).catch(()=>setTranscription(false));},[]);
  useEffect(()=>{if(interview?.status==='completed')navigate(`/interview/${id}/results`,{replace:true});},[interview,id,navigate]);
  useEffect(() => {
    if (!['queued', 'processing'].includes(interview?.processingState ?? '')) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const d = await api<InterviewResponse>(`/interviews/${id}`);
        if (live) { apply(d); setError(''); }
      } catch { if (live) setError('Connection interrupted. Your saved answer is safe; reconnecting...'); }
      if (live) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [id, interview?.processingState]);
  const elapsed=useQuestionElapsed(interview,skew);
  async function post(path: string) {
    setBusy(true); setError('');
    try { apply(await api<InterviewResponse>(`/interviews/${id}/${path}`, {method:'POST'})); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function submit(e:FormEvent){e.preventDefault();if(!interview||busy||voiceBusy)return;setBusy(true);setError('');
    try{const d=await api<InterviewResponse>(`/interviews/${id}/answer`,{method:'POST',body:JSON.stringify({answer,questionIndex:interview.turns.length,submissionId:`${interview._id}:${interview.turns.length}`})});apply(d);setAnswer('');
      if(d.interview.status==='completed')navigate(`/interview/${id}/results`,{replace:true});
    }catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  if(!interview)return error?<div className="page-enter"><div className="alert error">{error}</div><Link to="/dashboard" className="back-link">Back to dashboard</Link></div>:<LoadingScreen/>;
  const waiting = interview.processingState && interview.processingState !== 'ready';
  const limit = interview.timeLimitSeconds;
  const paused = !!limit && !!interview.pausedAt;
  const timeUp = !!limit && elapsed !== null && elapsed >= limit;
  const current=Math.min(interview.turns.length+1, interview.totalQuestions);
  const pct=Math.min(100,Math.round((interview.turns.length/interview.totalQuestions)*100));
  return <div className="page-enter interview-page">
    <div className="interview-head"><Link className="back-link" to="/dashboard"><ArrowLeft size={16}/> Dashboard</Link><div className="interview-live"><span className="live-circle"/> {mode==='ai'?'AI interview':'Guided practice'} <span className="session-divider">·</span> {interview.type}</div></div>
    <div className="page-heading"><div><h1>{interview.role}</h1><p>{interview.topic} · {interview.difficulty} · Question {current} of {interview.totalQuestions}{limit?` · ${clock(limit)} per question`:''}</p></div><span className="status-chip"><Clock3 size={14}/> In progress</span></div>
    <div className="progress-top"><span>Interview progress</span><b>{pct}% complete</b></div><div className="progress-track"><div style={{width:`${pct}%`}}/></div>
    <div className="interview-layout"><section className="interview-main">
      {!waiting && limit && elapsed !== null && <QuestionTimer limit={limit} elapsed={elapsed} paused={paused} busy={busy} onPause={()=>post('pause')}/>}
      {!waiting && paused && <PausedCard busy={busy} onResume={()=>post('resume')}/>}
      {!waiting && paused && error && <div className="alert error" role="alert">{error}</div>}
      {!waiting && !paused && <article className="card question-card"><div className="question-card-head"><span className="ai-avatar"><BrainCircuit size={24}/></span><div><b>{mode==='ai'?'AI Interviewer':'Practice Interviewer'}</b><span>Question {current} · {interview.currentTopic}</span></div><span className="question-badge"><Sparkles size={13}/> Question {current}</span></div><h2>{interview.currentQuestion}</h2><div className="question-foot"><Info size={16}/> Explain your thought process and use examples where possible.<ReadAloud text={interview.currentQuestion}/></div></article>}
      {!waiting && !paused && <form className="card answer-card" onSubmit={submit}><div className="answer-header"><span><UserRound size={18}/> Your response</span><span>{answer.length}/3500</span></div><textarea value={answer} onChange={e=>setAnswer(e.target.value)} placeholder={'Start typing your answer here...\n\nTry explaining the concept, giving an example, and mentioning tradeoffs.'} minLength={10} maxLength={3500} required disabled={busy} rows={9}/>{mode==='ai' && transcription && <VoiceAnswer key={`${interview._id}:${interview.turns.length}`} interviewId={interview._id} disabled={busy} onBusy={setVoiceBusy} onTranscript={text=>{const combined=(answer.trim()?answer.trimEnd()+' ':'')+text;if(combined.length>3500)return false;setAnswer(combined);return true;}}/>}{timeUp && <p className="time-up-note" role="status">Time is up. Finish your thought and submit; your results will show how long this answer took.</p>}<div className="answer-actions"><span><CircleCheck size={15}/> {limit?`Timed round: ${clock(limit)} per question`:'You can take your time'}</span><button type="submit" disabled={busy||voiceBusy||answer.trim().length<10||answer.length>3500} className="button primary">{busy?'Thinking...':current===interview.totalQuestions?'Finish interview':'Submit & continue'} <Send size={16}/></button></div>{error&&<div className="alert error" role="alert">{error}</div>}</form>}
      {waiting && <div className="card answer-card" role="status" aria-live="polite">
        <h2>Your answer is saved</h2>
        {interview.processingState === 'queued' && interview.processingError && <p>{interview.processingError}</p>}
        <p>{interview.processingState === 'failed'
          ? 'Processing could not finish. Retry without submitting your answer again.'
          : interview.turns.length >= interview.totalQuestions ? 'Preparing your feedback. You can leave this page and return later.' : 'Preparing your next question. You can leave this page and return later.'}</p>
        {interview.processingState === 'failed' && <button className="button primary" disabled={busy} onClick={()=>post('retry')}>{busy ? 'Retrying...' : 'Retry processing'}</button>}
        {error && <div className="alert error" role="alert">{error}</div>}
      </div>}
    </section><aside className="interview-aside"><div className="card session-card"><h3>Session overview</h3><div className="session-stat"><span>Role</span><b>{interview.role}</b></div><div className="session-stat"><span>Type</span><b>{interview.type}</b></div><div className="session-stat"><span>Difficulty</span><b>{interview.difficulty}</b></div>{limit&&<div className="session-stat"><span>Timing</span><b>{clock(limit)} per question</b></div>}<div className="session-stat"><span>Progress</span><b>{interview.turns.length} / {interview.totalQuestions} answered</b></div><div className="tiny-steps">{Array.from({length:interview.totalQuestions},(_,i)=><span key={i} className={i<interview.turns.length?'done':i===interview.turns.length?'current':''}>{i<interview.turns.length?<CircleCheck size={14}/>:i+1}</span>)}</div></div>
      <div className="hint-box"><Sparkles size={18}/><span>{mode==='ai'?'Your follow-up questions adapt to what you say.':'Practice mode uses curated questions. Add an AI API key for adaptive interviews and scores.'}</span></div>
      {interview.turns.length>0&&<div className="card prior-card"><h3>Answered questions</h3>{interview.turns.map((t,i)=><details key={i}><summary><CircleCheck size={16}/> Question {i+1} <ArrowRight size={14}/></summary><p>{t.question}</p><blockquote>{t.answer}</blockquote></details>)}</div>}
    </aside></div>
  </div>;
}
