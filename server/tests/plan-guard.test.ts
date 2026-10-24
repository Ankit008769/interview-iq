import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../../infra/terraform/plan-guard.mjs', import.meta.url));
const change = (address: string, actions: string[], importing = false) => ({ address, change: { actions, ...(importing ? { importing: { id: 'x' } } : {}) } });
const run = (changes: object[], adopt = false) => {
  const result = spawnSync(process.execPath, [guard, ...(adopt ? ['--adopt'] : [])], { input: JSON.stringify({ resource_changes: changes }), encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
};

it('allows an import-only adoption plan and reports what it saw', () => {
  const { code, out } = run([change('google_compute_disk.mongo_data', ['no-op'], true), change('google_compute_network.staging', ['no-op'], true)], true);
  expect(code).toBe(0);
  expect(out).toContain('"import":2');
});

it('blocks creates and updates only in adoption mode', () => {
  const plan = [change('google_compute_instance.mongo', ['update'], true), change('google_project_service.apis["run.googleapis.com"]', ['create'])];
  expect(run(plan, true).code).toBe(1);
  expect(run(plan, true).out).toMatch(/update\s+google_compute_instance\.mongo/);
  expect(run(plan).code).toBe(0);
});

it('always blocks deletes and replacements', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    const { code, out } = run([change('google_compute_disk.mongo_data', actions)]);
    expect(code).toBe(1);
    expect(out).toMatch(/(delete|replace)\s+google_compute_disk\.mongo_data/);
  }
});
