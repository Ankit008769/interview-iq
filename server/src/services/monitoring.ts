// Deliberately bounded structured fields: never log exceptions, prompts, URLs,
// credentials, email addresses or candidate content.
export function operationalEvent(event: 'api_error' | 'worker_database_error' | 'worker_heartbeat' | 'interview_processing_failure' | 'score_challenge_failure' | 'answer_rewrite_failure' | 'deletion_ledger_failure', severity: 'INFO' | 'WARNING' | 'ERROR') {
  console.log(JSON.stringify({severity, event, component:'interviewiq', timestamp:new Date().toISOString()}));
}
