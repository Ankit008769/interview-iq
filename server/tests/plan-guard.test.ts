import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../../infra/terraform/plan-guard.mjs', import.meta.url));
const change = (address: string, actions: string[], importing = false) => ({ address, change: { actions, ...(importing ? { importing: { id: 'x' } } : {}) } });
const run = (changes: object[], adopt = false) => {
  return runPlan({ format_version: '1.2', planned_values: {}, configuration: {}, resource_changes: changes }, adopt);
};
const runPlan = (plan: unknown, adopt = false) => {
  const result = spawnSync(process.execPath, [guard, ...(adopt ? ['--adopt'] : [])], { input: JSON.stringify(plan), encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
};

it('allows an import-only adoption plan and reports what it saw', () => {
  const { code, out } = run([change('google_compute_disk.mongo_data', ['no-op'], true), change('google_compute_network.staging', ['no-op'], true)], true);
  expect(code).toBe(0);
  expect(out).toContain('"import":2');
});

it('rejects empty, state-only, errored, deferred and incomplete plans', () => {
  const valid = { format_version: '1.2', planned_values: {}, configuration: {}, resource_changes: [] };
  for (const plan of [null, {}, { format_version: '1.0', values: {} },
    { ...valid, format_version: '2.0' }, { ...valid, errored: true },
    { ...valid, complete: false }, { ...valid, deferred_changes: [{}] },
    { ...valid, resource_changes: {} }]) {
    expect(runPlan(plan, true).code).toBe(1);
  }
  expect(runPlan(valid, true).code).toBe(0);
});

it('rejects missing and unrecognized actions instead of treating them as no-ops', () => {
  for (const actions of [[], ['forget'], ['update', 'read']]) {
    expect(run([change('google_compute_disk.mongo_data', actions)], true).code).toBe(1);
  }
  expect(run([{ address: 'missing.actions' }], true).code).toBe(1);
  expect(run([change('data.google_project.current', ['read'])], true).code).toBe(0);
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
