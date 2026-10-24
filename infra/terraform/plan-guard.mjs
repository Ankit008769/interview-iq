// Usage: terraform show -json tfplan | node ../plan-guard.mjs [--adopt]
// Fails if the plan deletes or replaces anything. With --adopt (first run after writing import
// blocks) it also fails on any create or update, so the only allowed actions are imports and no-ops.
import { readFileSync } from 'node:fs';

const adopt = process.argv.includes('--adopt');
const plan = JSON.parse(readFileSync(0, 'utf8'));
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
