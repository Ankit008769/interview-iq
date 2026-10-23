import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Award, BookOpen, BrainCircuit, CheckCircle2, CircleAlert, ClipboardCheck, RotateCcw, Sparkles, Target } from 'lucide-react';
import { api, type Interview } from '../lib/api';
import { LoadingScreen } from '../components/Layout';
export function Results() {
  const {id}=useParams();const [interview,setInterview]=useState<Interview|null>(null);const [error,setError]=useState('');
  useEffect(()=>{api<{interview:Interview}>(`/interviews/${id}`).then(d=>setInterview(d.interview)).catch(e=>setError(e.message));},[id]);
  if(!interview)return error?<div className="alert error">{error}</div>:<LoadingScreen/>;
  if(interview.status!=='completed')return <div className="card padding-card"><h2>Interview still in progress</h2><Link to={`/interview/${id}`} className="button primary">Continue <ArrowRight size={16}/></Link></div>;
  const feedback=interview.feedback;
  return <div className="page-enter results-page"><Link to="/dashboard" className="back-link"><ArrowLeft size={16}/> Back to dashboard</Link><div className="results-banner"><span className="results-icon"><Award size={28}/></span><span className="eyebrow">SESSION COMPLETE</span><h1>Great work showing up!</h1><p>Every interview is a chance to learn. Here's a summary of your session.</p><div className="results-banner-actions"><Link className="button light" to="/interview/new">Practice again <RotateCcw size={16}/></Link><Link className="button outline-white" to="/history">View history <ArrowRight size={16}/></Link></div></div>
  <div className="results-grid"><div className="card result-summary"><div className="result-symbol"><Target size={22}/></div><span>Interview score</span><strong>{feedback?.source==='ai' && feedback.score!==null?`${feedback.score}/100`:'Not scored'}</strong><p>{feedback?.source==='ai'?'AI-generated coaching estimate':'Practice mode — no automated grading'}</p></div><div className="card result-summary"><div className="result-symbol blue"><ClipboardCheck size={22}/></div><span>Questions answered</span><strong>{interview.turns.length} / {interview.totalQuestions}</strong><p>Completed {new Date(interview.completedAt||interview.createdAt).toLocaleDateString()}</p></div></div>
  <div className="card feedback-card"><span className="eyebrow"><Sparkles size={15}/> SESSION REVIEW</span><h3>{interview.role} · {interview.topic}</h3><p className="feedback-summary">{feedback?.summary||'Feedback is not available for this session.'}</p></div>
  <div className="feedback-grid"><div className="card feedback-card"><div className="feedback-heading"><CheckCircle2 size={20}/> <h3>Strengths</h3></div><ul>{feedback?.strengths.map((s,i)=><li key={i}>{s}</li>)}</ul></div><div className="card feedback-card"><div className="feedback-heading amber"><CircleAlert size={20}/> <h3>Areas to improve</h3></div><ul>{feedback?.improvements.map((s,i)=><li key={i}>{s}</li>)}</ul></div></div>
  <div className="card feedback-card"><div className="feedback-heading"><BookOpen size={20}/><h3>Your next steps</h3></div><ol>{feedback?.nextSteps.map((s,i)=><li key={i}>{s}</li>)}</ol></div>
  <div className="section-title space-top"><div><h3>Your answers</h3><p>Review everything you shared during this interview</p></div></div>
  <div className="answer-history">{interview.turns.map((turn,i)=><div className="card review-turn" key={i}><span className="question-label"><BrainCircuit size={16}/> QUESTION {i+1} · {turn.topic}</span><h4>{turn.question}</h4><div className="review-answer">{turn.answer}</div></div>)}</div>
  </div>;
}
