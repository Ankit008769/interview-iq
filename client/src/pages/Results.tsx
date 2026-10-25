import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Award, BookOpen, BrainCircuit, CheckCircle2, CircleAlert, ClipboardCheck, RotateCcw, Sparkles, Target } from 'lucide-react';
import { api, type Interview, type User } from '../lib/api';
import { LoadingScreen } from '../components/Layout';
import { EvidenceReview, RubricGuide } from '../components/EvidenceReview';
import { TurnTiming, clock } from '../components/Timing';
import { QuestionSource } from '../components/Grounding';
import { DeliveryPanel } from '../components/Delivery';
import { useAuth } from '../components/AuthProvider';
export function Results() {
  const {id}=useParams();const [interview,setInterview]=useState<Interview|null>(null);const [error,setError]=useState('');
  const {user,setUser}=useAuth();const [deliveryOff,setDeliveryOff]=useState(false);
  useEffect(()=>{api<{interview:Interview}>(`/interviews/${id}`).then(d=>setInterview(d.interview)).catch(e=>setError(e.message));},[id]);
  // Poll only while a second review is running; a failed poll just waits for the next one.
  const pending=!!interview?.challenges?.some(c=>c.state==='queued'||c.state==='processing');
  useEffect(()=>{if(!pending)return;const timer=setTimeout(()=>{api<{interview:Interview}>(`/interviews/${id}`).then(d=>setInterview(d.interview)).catch(()=>{});},2500);return()=>clearTimeout(timer);},[pending,interview,id]);
  const requestChallenge=async(questionIndex:number,criterionId:string,reason:string,submissionId:string)=>{
    const d=await api<{interview:Interview}>(`/interviews/${id}/challenges`,{method:'POST',body:JSON.stringify({questionIndex,criterionId,reason,submissionId})});setInterview(d.interview);};
  const requestRewrite=async(questionIndex:number)=>{
    const d=await api<{interview:Interview}>(`/interviews/${id}/rewrites`,{method:'POST',body:JSON.stringify({questionIndex}),timeoutMs:300_000});setInterview(d.interview);};
  const requestStar=async(questionIndex:number)=>{
    const d=await api<{interview:Interview}>(`/interviews/${id}/star`,{method:'POST',body:JSON.stringify({questionIndex}),timeoutMs:300_000});setInterview(d.interview);};
  const turnOffDelivery=async()=>{
    const d=await api<{user:User}>('/account/preferences',{method:'PATCH',body:JSON.stringify({deliveryMetrics:false})});setUser(d.user);setDeliveryOff(true);};
  if(!interview)return error?<div className="alert error">{error}</div>:<LoadingScreen/>;
  if(interview.status!=='completed')return <div className="card padding-card"><h2>Interview still in progress</h2><Link to={`/interview/${id}`} className="button primary">Continue <ArrowRight size={16}/></Link></div>;
  const feedback=interview.feedback;
  const hasEvidence=feedback?.source==='ai' && !!feedback.answers?.length;
  const challenges=interview.challenges??[];
  const revised=feedback?.answers?.flatMap(a=>a.criteria).filter(c=>c.revisedBy).length??0;
  const limit=interview.timeLimitSeconds;
  const timed=interview.turns.filter(t=>t.elapsedSeconds!==undefined);
  return <div className="page-enter results-page"><Link to="/dashboard" className="back-link"><ArrowLeft size={16}/> Back to dashboard</Link><div className="results-banner"><span className="results-icon"><Award size={28}/></span><span className="eyebrow">SESSION COMPLETE</span><h1>Great work showing up!</h1><p>Every interview is a chance to learn. Here's a summary of your session.</p><div className="results-banner-actions"><Link className="button light" to="/interview/new">Practice again <RotateCcw size={16}/></Link><Link className="button outline-white" to="/history">View history <ArrowRight size={16}/></Link></div></div>
  <div className="results-grid"><div className="card result-summary"><div className="result-symbol"><Target size={22}/></div><span>Interview score</span><strong>{feedback?.source==='ai' && feedback.score!==null?`${feedback.score}/100`:'Not scored'}</strong><p>{feedback?.source==='ai'?'AI-generated coaching estimate':'Practice mode — no automated grading'}</p></div><div className="card result-summary"><div className="result-symbol blue"><ClipboardCheck size={22}/></div><span>Questions answered</span><strong>{interview.turns.length} / {interview.totalQuestions}</strong><p>Completed {new Date(interview.completedAt||interview.createdAt).toLocaleDateString()}</p></div></div>
  <div className="card feedback-card"><span className="eyebrow"><Sparkles size={15}/> SESSION REVIEW</span><h3>{interview.role} · {interview.topic}</h3><p className="feedback-summary">{feedback?.summary||'Feedback is not available for this session.'}</p>{limit&&timed.length>0&&<p className="timing-summary">Timed round: {timed.filter(t=>!t.overTime).length} of {timed.length} {timed.length===1?'answer':'answers'} within the {clock(limit)} limit.</p>}</div>
  {feedback && <><div className="feedback-grid"><div className="card feedback-card"><div className="feedback-heading"><CheckCircle2 size={20}/> <h3>Strengths</h3></div>{feedback.strengths.length?<ul>{feedback.strengths.map((s,i)=><li key={i}>{s}</li>)}</ul>:<p>No strengths could be tied to your own words this time. Answer each question directly, with an example, so there is something to point to.</p>}</div><div className="card feedback-card"><div className="feedback-heading amber"><CircleAlert size={20}/> <h3>Areas to improve</h3></div><ul>{feedback?.improvements.map((s,i)=><li key={i}>{s}</li>)}</ul></div></div>
  <div className="card feedback-card"><div className="feedback-heading"><BookOpen size={20}/><h3>Your next steps</h3></div><ol>{feedback?.nextSteps.map((s,i)=><li key={i}>{s}</li>)}</ol></div></>}
  {hasEvidence && <div className="card feedback-card"><h3>Evidence-based scorecard</h3><p>Choose a criterion to highlight its supporting words in your answer. The overall score averages every criterion; a criterion with no evidence in your answer counts as 0.</p><p>Quote matching verifies where evidence comes from; it does not prove the AI's interpretation is correct. These ratings have not yet been calibrated against expert reviewers.</p><p>If a rating looks wrong, you can ask for a second AI review of up to 3 ratings in this interview. It re-checks only your saved answer, and the score can go up, down or stay the same.</p>{revised>0&&<p className="challenge-summary">{revised} {revised===1?'rating was':'ratings were'} changed by a second AI review. The overall estimate includes {revised===1?'this change':'these changes'}.</p>}</div>}
  {user?.preferences?.deliveryMetrics!==false && !!interview.deliveryClips?.length && <DeliveryPanel clips={interview.deliveryClips} onTurnOff={turnOffDelivery}/>}
  {deliveryOff && <p className="card feedback-card" role="status">Delivery feedback is off. Turn it back on in <Link to="/account">Account</Link>.</p>}
  {feedback?.rubric && <RubricGuide rubric={feedback.rubric}/>}
  <div className="section-title space-top"><div><h3>Your answers</h3><p>Review everything you shared during this interview</p></div></div>
  <div className="answer-history">{interview.turns.map((turn,i)=>{
    const evaluated=feedback?.answers?.find(a=>a.questionIndex===i);
    return evaluated ? <EvidenceReview key={i} turn={turn} index={i} criteria={evaluated.criteria} review={evaluated.review} technical={interview.type==='Technical'}
      challenges={challenges.filter(c=>c.questionIndex===i)} canChallenge={challenges.length<3}
      onChallenge={(criterionId,reason,submissionId)=>requestChallenge(i,criterionId,reason,submissionId)}
      rewrite={interview.rewrites?.find(r=>r.questionIndex===i)} onRewrite={()=>requestRewrite(i)}
      star={interview.starChecks?.find(c=>c.questionIndex===i)} onStar={interview.type==='Behavioral'?()=>requestStar(i):undefined} limit={limit}/> : <div className="card review-turn" key={i}><span className="question-label"><BrainCircuit size={16}/> QUESTION {i+1} · {turn.topic}</span><h4>{turn.question}</h4><QuestionSource grounding={turn.grounding}/><TurnTiming turn={turn} limit={limit}/><div className="review-answer">{turn.answer}</div></div>;
  })}</div>
  {feedback?.generation && <details className="card rubric-guide"><summary>How this review was generated</summary><p>Provider: {feedback.generation.provider} · Model: {feedback.generation.model} · Prompt: {feedback.generation.promptVersion}</p><p>The rubric and generation versions are saved with this report. Model updates do not rewrite past ratings. A rating you challenge can change after a second AI review; its original is kept in your interview record.</p></details>}
  </div>;
}
