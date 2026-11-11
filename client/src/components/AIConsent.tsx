import { useEffect, useState } from 'react';
import { api } from '../lib/api';
interface Disclosure {version:string;provider:string;endpoint:string;interviewerModel:string;judgeModel:string;description:string;retention:string;withdrawal:string;transcriptionModel?:string;voice?:string;documents?:string;coding?:string;projects?:string;design?:string}
interface Consent {disclosure:Disclosure|null;accepted:boolean;hasGrant:boolean}
export function AIConsent({onChange}:{onChange?:(ready:boolean, aiAvailable:boolean)=>void}) {
  const [data,setData]=useState<Consent>();const [checked,setChecked]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function load(){setError('');try{const next=await api<Consent>('/account/ai-consent');setData(next);setChecked(false);onChange?.(next.accepted,!!next.disclosure);}catch(e){setError((e as Error).message);onChange?.(false,false);}}
  useEffect(()=>{void load();},[]);
  async function save(accept:boolean){setBusy(true);setError('');try{await api('/account/ai-consent',{method:accept?'POST':'DELETE',...(accept?{body:JSON.stringify({version:data?.disclosure?.version,accepted:true})}:{})});await load();}catch(e){setError((e as Error).message);onChange?.(false,!!data?.disclosure);}finally{setBusy(false);}}
  return <section className="ai-consent"><h2>AI processing permission</h2>
    {error&&<div className="alert error" role="alert">{error} <button type="button" className="button" onClick={load}>Reload AI details</button></div>}
    {!data?<p>Loading provider details…</p>:<>{data.disclosure?<>
      {!data.accepted&&<p className="ai-unlocks">{data.hasGrant?'AI processing changed since you last accepted (for example, voice answers were added). Review the details and accept again to keep using AI interviews.':'Needed for AI interviews: freshly written questions, scoring with a verdict, key points and tips for every answer, Hindi or Hinglish, voice answers and resume tailoring.'}</p>}
      <p><strong>{data.disclosure.provider}</strong> · {data.disclosure.endpoint}</p>
      <p>Question model: {data.disclosure.interviewerModel}. Feedback model: {data.disclosure.judgeModel}.{data.disclosure.transcriptionModel&&` Transcription model: ${data.disclosure.transcriptionModel}.`}</p>
      <p>{data.disclosure.description}</p>{data.disclosure.documents&&<p>{data.disclosure.documents}</p>}{data.disclosure.voice&&<p>{data.disclosure.voice}</p>}{data.disclosure.coding&&<p>{data.disclosure.coding}</p>}{data.disclosure.projects&&<p>{data.disclosure.projects}</p>}{data.disclosure.design&&<p>{data.disclosure.design}</p>}<p>{data.disclosure.retention}</p><p>{data.disclosure.withdrawal}</p>
      {data.accepted?<p role="status">Permission granted for this provider configuration.</p>:<>
        <label className="consent-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> I agree to send my interview content to this provider for AI coaching.</label>
        <button type="button" className="button" disabled={!checked||busy} onClick={()=>save(true)}>Allow AI processing</button></>}
    </>:<p>Practice mode is active. No interview content is sent to an AI provider.</p>}
    {data.hasGrant&&<button type="button" className="button" disabled={busy} onClick={()=>save(false)}>Withdraw AI permission</button>}</>}
  </section>;
}
