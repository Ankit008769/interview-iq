export const project='project-12b39f1f-9d49-456e-957';
export const host='interview-iq-341474411884.asia-south1.run.app';
const snapshot='resource.type="gce_disk" AND resource.labels.disk_id="1864710073775211764" AND protoPayload.methodName="ScheduledSnapshots"';
export const metrics=[
 {name:'interviewiq_snapshot_success',filter:snapshot+' AND operation.last=true AND protoPayload.response.status="DONE" AND NOT protoPayload.response.error:* AND severity<=INFO'},
 {name:'interviewiq_snapshot_failure',filter:snapshot+' AND (severity>INFO OR protoPayload.response.error:*)'},
 {name:'interviewiq_worker_heartbeat',filter:'resource.type="cloud_run_revision" AND resource.labels.service_name="interview-iq" AND jsonPayload.component="interviewiq" AND jsonPayload.event="worker_heartbeat"'},
 {name:'interviewiq_application_error',filter:'resource.type="cloud_run_revision" AND resource.labels.service_name="interview-iq" AND jsonPayload.component="interviewiq" AND severity>=ERROR'},
];
export const uptime={displayName:'Interview IQ database health',monitoredResource:{type:'uptime_url',labels:{project_id:project,host}},httpCheck:{path:'/api/health',port:443,useSsl:true,validateSsl:true,requestMethod:'GET'},period:'60s',timeout:'10s',contentMatchers:[{content:'"database":"connected"',matcher:'CONTAINS_STRING'}]};
export function policies(channel,checkId){
 const common={combiner:'OR',enabled:true,notificationChannels:[channel],alertStrategy:{autoClose:'604800s'},userLabels:{application:'interviewiq'}};
 const filter=(name,resource)=>`metric.type="logging.googleapis.com/user/${name}" AND resource.type="${resource}"`;
 const count=(f)=>({filter:f,comparison:'COMPARISON_GT',thresholdValue:0,duration:'0s',aggregations:[{alignmentPeriod:'300s',perSeriesAligner:'ALIGN_SUM'}],trigger:{count:1}});
 // Reduce across revisions so retiring an old revision does not create a false alert.
 const absent=(f,d)=>({filter:f,duration:d,aggregations:[{alignmentPeriod:'60s',perSeriesAligner:'ALIGN_SUM',crossSeriesReducer:'REDUCE_SUM'}],trigger:{count:1}});
 const policy=(name,condition,content)=>({...common,displayName:name,conditions:[{displayName:name,...condition}],documentation:{mimeType:'text/markdown',content}});
 return [
  policy('Interview IQ health unavailable',{conditionThreshold:{filter:`metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.labels.check_id="${checkId}"`,comparison:'COMPARISON_GT',thresholdValue:1,duration:'120s',aggregations:[{alignmentPeriod:'60s',perSeriesAligner:'ALIGN_NEXT_OLDER',crossSeriesReducer:'REDUCE_COUNT_FALSE',groupByFields:['resource.label.host']}],trigger:{count:1}}},'Two checker locations have failed database health for two minutes. Check Cloud Run and MongoDB. Do not change IAM to silence an alert.'),
  policy('Interview IQ scheduled backup failed',{conditionThreshold:count(filter('interviewiq_snapshot_failure','gce_disk'))},'A scheduled snapshot warning/error occurred for interviewiq-mongo-data. Inspect audit logs and the newest READY snapshot; preserve retained backups.'),
  policy('Interview IQ backup success missing for 3 hours',{conditionAbsent:absent(filter('interviewiq_snapshot_success','gce_disk'),'10800s')},'No completed scheduled snapshot event for three hours. Inspect policy attachment, latest READY snapshot and logging ingestion. Requires a first post-creation metric point; this is event freshness, not a restore guarantee.'),
  policy('Interview IQ worker heartbeat missing',{conditionAbsent:absent(filter('interviewiq_worker_heartbeat','cloud_run_revision'),'600s')},'No successful database worker heartbeat for ten minutes. Check CPU allocation, database access and worker startup. Requires instrumented code and an initial heartbeat.'),
  policy('Interview IQ application errors',{conditionThreshold:count(filter('interviewiq_application_error','cloud_run_revision'))},'Sanitized application/worker error detected. Check the deployed revision. Logs intentionally exclude candidate content and credentials.'),
  policy('Interview IQ elevated request latency',{conditionThreshold:{filter:'resource.type="cloud_run_revision" AND resource.labels.service_name="interview-iq" AND metric.type="run.googleapis.com/request_latencies"',comparison:'COMPARISON_GT',thresholdValue:10000,duration:'300s',aggregations:[{alignmentPeriod:'300s',perSeriesAligner:'ALIGN_PERCENTILE_95'}],trigger:{count:1}}},'P95 request latency exceeds 10 seconds for five minutes. Inspect database and provider latency before changing resources.'),
 ];
}
export function dashboard(){
 const chart=(title,filter,aligner)=>({title,xyChart:{dataSets:[{timeSeriesQuery:{timeSeriesFilter:{filter,aggregation:{alignmentPeriod:'60s',perSeriesAligner:aligner}}}}],yAxis:{label:'',scale:'LINEAR'}}});
 return {displayName:'Interview IQ operations',gridLayout:{columns:'2',widgets:[
  chart('Request rate','resource.type="cloud_run_revision" AND resource.labels.service_name="interview-iq" AND metric.type="run.googleapis.com/request_count"','ALIGN_RATE'),
  chart('P95 latency (ms)','resource.type="cloud_run_revision" AND resource.labels.service_name="interview-iq" AND metric.type="run.googleapis.com/request_latencies"','ALIGN_PERCENTILE_95'),
  ...metrics.map(m=>chart(m.name,`metric.type="logging.googleapis.com/user/${m.name}" AND resource.type="${m.name.includes('snapshot')?'gce_disk':'cloud_run_revision'}"`,'ALIGN_SUM')),
 ]}};
}
