// Usage: terraform show -json tfplan | node ../plan-guard.mjs [--adopt]
// Fails if the plan deletes or replaces anything. With --adopt (first run after writing import
// blocks) it also fails on any create or update, so the only allowed actions are imports and no-ops.
import { readFileSync } from 'node:fs';

const adopt = process.argv.includes('--adopt');
let plan;
try {
  plan = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  if (!plan || !/^1\.\d+$/.test(plan.format_version ?? '') ||
      !plan.planned_values || !plan.configuration ||
      plan.errored === true || plan.complete === false ||
      (plan.deferred_changes?.length ?? 0) > 0 ||
      (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes))) {
    throw new Error('Expected a complete, successful Terraform plan in JSON format version 1.x.');
  }
  const allowed = new Set(['no-op', 'read', 'create', 'update', 'delete', 'delete,create', 'create,delete']);
  for (const resource of plan.resource_changes ?? []) {
    if (typeof resource.address !== 'string' || !Array.isArray(resource.change?.actions) ||
        !allowed.has(resource.change.actions.join(','))) {
      throw new Error('Missing or unsupported resource actions.');
    }
  }
} catch (error) {
  console.error(`Plan blocked: ${error.message}`);
  process.exit(1);
}
const counts = { import: 0, create: 0, update: 0, delete: 0, replace: 0, noop: 0 };
const blocked = [];
for (const change of plan.resource_changes ?? []) {
  const actions = change.change?.actions ?? [];
  const imported = Boolean(change.change?.importing);
  const kind = actions.includes('delete') && actions.includes('create') ? 'replace'
    : actions.includes('delete') ? 'delete' : actions.includes('create') ? 'create'
      : actions.includes('update') ? 'update' : 'noop';
  if (imported) counts.import++;
  counts[kind]++;
  if (kind === 'delete' || kind === 'replace' || (adopt && (kind === 'create' || kind === 'update'))) blocked.push(`${kind.padEnd(7)} ${change.address}`);
}
console.log(JSON.stringify(counts));
if (blocked.length) {
  console.error(`Plan blocked (${adopt ? 'adoption mode' : 'no deletes or replacements'}):\n${blocked.join('\n')}`);
  process.exitCode = 1;
} else console.log(adopt ? 'Adoption plan is imports and no-ops only.' : 'No deletes or replacements.');
