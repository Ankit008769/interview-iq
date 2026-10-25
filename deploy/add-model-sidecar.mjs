#!/usr/bin/env node
// Turns the live Cloud Run service (gcloud run services describe SERVICE --format=json) into a manifest for
// `gcloud run services replace` that adds the Ollama model sidecar and switches the app to AI_PROVIDER=local.
// Every other setting (secrets, VPC, scaling, service account) is kept. Traffic stays pinned to the revision
// that is serving now, so the new revision starts with no traffic until it has been checked.
//   node deploy/add-model-sidecar.mjs --in live.json --out next.json --revision interview-iq-local-models-abc1234 \
//     --model-image IMAGE [--app-image IMAGE] [--commit SHA] [--model-cpu 6] [--model-memory 8Gi] [--request-timeout 600]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT_ONLY_METADATA = ['uid', 'selfLink', 'resourceVersion', 'generation', 'creationTimestamp'];
const OUTPUT_ONLY_ANNOTATIONS = ['serving.knative.dev/creator', 'serving.knative.dev/lastModifier', 'run.googleapis.com/operation-id',
  'run.googleapis.com/urls', 'run.googleapis.com/ingress-status', 'run.googleapis.com/satisfiesPzs'];
const MODEL_ENV = ['AI_PROVIDER', 'LLM_BASE_URL', 'INTERVIEWER_MODEL', 'JUDGE_MODEL', 'AI_MODEL'];

export function addModelSidecar(live, { revision, modelImage, appImage, commit, modelCpu = '6', modelMemory = '8Gi', requestTimeout = 600 }) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(revision ?? '')) throw new Error('A valid --revision name is required.');
  if (!modelImage) throw new Error('--model-image is required.');
  const svc = structuredClone(live);
  const serving = svc.status?.traffic?.find(t => t.percent === 100)?.revisionName ?? svc.status?.latestReadyRevisionName;
  if (!serving) throw new Error('Cannot tell which revision is serving; refusing to change traffic.');
  if (!revision.startsWith(`${svc.metadata.name}-`)) throw new Error(`Revision names must start with ${svc.metadata.name}-.`);
  delete svc.status;
  for (const key of OUTPUT_ONLY_METADATA) delete svc.metadata[key];
  for (const key of OUTPUT_ONLY_ANNOTATIONS) delete svc.metadata.annotations?.[key];
  // Annotations from an earlier source build describe a different image.
  for (const key of Object.keys(svc.metadata.annotations ?? {})) if (key.startsWith('run.googleapis.com/build-')) delete svc.metadata.annotations[key];

  const template = svc.spec.template;
  template.metadata = { ...template.metadata, name: revision, annotations: { ...template.metadata?.annotations } };
  const containers = template.spec.containers;
  if (containers.some(c => c.name === 'ollama')) throw new Error('The service already has a model sidecar.');
  const app = containers.find(c => c.ports?.length) ?? containers[0];
  if (containers.length !== 1 || !app) throw new Error('Expected exactly one existing (app) container.');
  app.name ||= 'app';
  if (appImage) app.image = appImage;
  app.env = [...(app.env ?? []).filter(e => !MODEL_ENV.includes(e.name)), { name: 'AI_PROVIDER', value: 'local' }];
  if (commit) app.env = app.env.map(e => e.name === 'DEPLOYMENT_COMMIT' ? { name: e.name, value: commit } : e);
  // First questions, rewrites and STAR checks wait on a CPU model while the browser waits.
  template.spec.timeoutSeconds = Math.max(Number(template.spec.timeoutSeconds ?? 0), Number(requestTimeout));
  template.spec.containers = [app, {
    name: 'ollama', image: modelImage,
    resources: { limits: { cpu: String(modelCpu), memory: modelMemory } },
    startupProbe: { httpGet: { path: '/api/version', port: 11434 }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
  }];
  // The app starts only after the model server answers.
  template.metadata.annotations['run.googleapis.com/container-dependencies'] = JSON.stringify({ [app.name]: ['ollama'] });
  svc.spec.traffic = [{ revisionName: serving, percent: 100 }];
  return { manifest: svc, serving };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  const { manifest, serving } = addModelSidecar(JSON.parse(readFileSync(args.get('in'), 'utf8')), {
    revision: args.get('revision'), modelImage: args.get('model-image'), appImage: args.get('app-image'), commit: args.get('commit'),
    modelCpu: args.get('model-cpu'), modelMemory: args.get('model-memory'), requestTimeout: args.get('request-timeout'),
  });
  writeFileSync(args.get('out'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${args.get('out')}. Traffic stays on ${serving} until you move it.`);
}
