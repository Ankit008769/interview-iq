// Supply a short-lived token via IQ_MONITORING_TOKEN, never argv or a source file.
import {project,metrics,uptime,policies,dashboard} from './monitoring-config.mjs';
const token=process.env.IQ_MONITORING_TOKEN;
if(!token)throw new Error('Missing IQ_MONITORING_TOKEN');
async function api(service,path,method='GET',body){
 const r=await fetch(`https://${service}.googleapis.com/${path}`,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();if(!r.ok)throw new Error(`${method} ${path}: ${r.status} ${data.error?.message||'failed'}`);return data;
}
const root=`v3/projects/${project}`;
const channels=await api('monitoring',`${root}/notificationChannels`);
let channel=channels.notificationChannels?.find(c=>c.type==='email'&&c.labels?.email_address==='ankitbhukar815@gmail.com');
if(!channel)channel=await api('monitoring',`${root}/notificationChannels`,'POST',{type:'email',displayName:'Interview IQ owner alerts',labels:{email_address:'ankitbhukar815@gmail.com'},enabled:true});
const existingMetrics=await api('logging',`v2/projects/${project}/metrics`);
for(const metric of metrics){
 if(existingMetrics.metrics?.some(m=>m.name===metric.name))await api('logging',`v2/projects/${project}/metrics/${metric.name}`,'PUT',metric);
 else await api('logging',`v2/projects/${project}/metrics`,'POST',metric);
}
const checks=await api('monitoring',`${root}/uptimeCheckConfigs`);
let check=checks.uptimeCheckConfigs?.find(c=>c.displayName===uptime.displayName);
if(!check)check=await api('monitoring',`${root}/uptimeCheckConfigs`,'POST',uptime);
const existing=await api('monitoring',`${root}/alertPolicies`);const created=[];
for(const policy of policies(channel.name,check.name.split('/').at(-1))){
 const old=existing.alertPolicies?.find(p=>p.displayName===policy.displayName);
 const saved=old?await api('monitoring','v3/'+old.name,'PATCH',{...policy,name:old.name}):await api('monitoring',`${root}/alertPolicies`,'POST',policy);
 created.push({name:saved.name,displayName:saved.displayName,enabled:saved.enabled});
}
const dashboards=await api('monitoring',`v1/projects/${project}/dashboards`);const desired=dashboard();const old=dashboards.dashboards?.find(d=>d.displayName===desired.displayName);
const saved=old?await api('monitoring','v1/'+old.name,'PATCH',{...desired,name:old.name,etag:old.etag}):await api('monitoring',`v1/projects/${project}/dashboards`,'POST',desired);
console.log(JSON.stringify({channel:channel.name,channelEnabled:channel.enabled,verificationStatus:channel.verificationStatus,uptime:check.name,dashboard:saved.name,policies:created},null,2));
