// Deliberately bounded structured fields: never log exceptions, prompts, URLs,
// credentials, email addresses or candidate content.
export function operationalEvent(event: 'api_error' | 'worker_database_error' | 'worker_heartbeat' | 'interview_processing_failure' | 'score_challenge_failure' | 'answer_rewrite_failure' | 'star_check_failure' | 'transcription_failure' | 'deletion_ledger_failure' | 'skill_update_failure' | 'code_runner_failure' | 'coding_follow_up_failure' | 'coding_review_failure' | 'project_claims_failure' | 'design_follow_up_failure' | 'design_review_failure', severity: 'INFO' | 'WARNING' | 'ERROR') {
  console.log(JSON.stringify({severity, event, component:'interviewiq', timestamp:new Date().toISOString()}));
}

// Audit trail for organisation administration (campus, D1): opaque IDs and counts only, never names,
// email addresses, roll numbers or file contents.
export type OrgAuditAction = 'org_created' | 'org_updated' | 'org_deleted' | 'org_join_code_rotated' | 'cohort_created' | 'cohort_deleted' | 'cohort_join_code_rotated'
  | 'cohort_exported' | 'member_joined' | 'member_left' | 'member_updated' | 'member_removed' | 'invitations_imported' | 'invitation_accepted' | 'invitation_cancelled'
  | 'assignment_created' | 'assignment_deleted' | 'pack_added';
export function orgAudit(action: OrgAuditAction, fields: { orgId: string; actorId: string; targetId?: string; count?: number }) {
  const ids = (value?: string) => (value && /^[a-f0-9]{24}$/.test(value) ? value : undefined);
  console.log(JSON.stringify({ severity: 'NOTICE', event: 'org_audit', action, component: 'interviewiq', orgId: ids(fields.orgId), actorId: ids(fields.actorId),
    ...(ids(fields.targetId) ? { targetId: fields.targetId } : {}), ...(Number.isInteger(fields.count) ? { count: fields.count } : {}), timestamp: new Date().toISOString() }));
}
