#!/usr/bin/env node
// Prepares Cloud Run manifests for staging releases from the live service
// (gcloud run services describe interview-iq --region=asia-south1 --format=json > live.json):
//
//   candidate  --in live.json --out next.json --revision interview-iq-NAME-SHA [--app-image IMG --commit SHA]
//              [--voice-image IMG] [--voice-model small]
//     New revision with no traffic, tagged "candidate", and the service maximum raised to 2 so it can start
//     next to the serving revision (the service normally allows one instance). --voice-image adds or replaces
//     the speech-to-text sidecar (deploy/whisper, 1 vCPU so Ollama keeps 6 within the 8 vCPU limit) and points
//     the app at it.
//   restore    --in live.json --out next.json
//     Same template (no new revision), service maximum back to 1.
//
// Then: gcloud run services replace next.json; check https://candidate---HOST/api/health; move traffic with
// gcloud run services update-traffic --to-revisions=REVISION=100 --remove-tags=candidate; then "restore".
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT_ONLY_METADATA = ['uid', 'selfLink', 'resourceVersion', 'generation', 'creationTimestamp'];
const OUTPUT_ONLY_ANNOTATIONS = ['serving.knative.dev/creator', 'serving.knative.dev/lastModifier', 'run.googleapis.com/operation-id',
  'run.googleapis.com/urls', 'run.googleapis.com/ingress-status', 'run.googleapis.com/satisfiesPzs'];
const MAX_CPU = 8;
// Cloud Run accepts per-container CPU of 0.08 to 1, or exactly 2, 4, 6 or 8.
const validCpu = cpu => (cpu >= 0.08 && cpu <= 1) || [2, 4, 6, 8].includes(cpu);

function strip(live) {
  const svc = structuredClone(live);
  delete svc.status;
  for (const key of OUTPUT_ONLY_METADATA) delete svc.metadata[key];
  for (const key of Object.keys(svc.metadata.annotations ?? {})) {
    if (OUTPUT_ONLY_ANNOTATIONS.includes(key) || key.startsWith('run.googleapis.com/build-')) delete svc.metadata.annotations[key];
  }
  return svc;
}
const setEnv = (container, name, value) => {
  container.env = [...(container.env ?? []).filter(e => e.name !== name), { name, value }];
};

export function candidate(live, { revision, appImage, commit, voiceImage, voiceModel = 'small' }) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(revision ?? '') || !revision.startsWith(`${live.metadata.name}-`)) {
    throw new Error(`A valid --revision starting with ${live.metadata.name}- is required.`);
  }
  const serving = live.status?.traffic?.find(t => t.percent === 100)?.revisionName;
  if (!serving) throw new Error('Cannot tell which revision is serving; refusing to change traffic.');
  if (serving === revision) throw new Error('That revision is already serving.');
  const svc = strip(live);
  const template = svc.spec.template;
  template.metadata = { ...template.metadata, name: revision, annotations: { ...template.metadata?.annotations } };
  const containers = template.spec.containers;
  const app = containers.find(c => c.name === 'app');
  if (!app) throw new Error('Expected an "app" container (run deploy/add-model-sidecar.mjs first).');
  if (appImage) app.image = appImage;
  if (commit) setEnv(app, 'DEPLOYMENT_COMMIT', commit);
  if (voiceImage) {
    template.spec.containers = [...containers.filter(c => c.name !== 'whisper'), {
      name: 'whisper', image: voiceImage,
      resources: { limits: { cpu: '1', memory: '2Gi' } },
      startupProbe: { httpGet: { path: '/health', port: 8000 }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    }];
    setEnv(app, 'TRANSCRIPTION_MODEL', voiceModel);
    setEnv(app, 'TRANSCRIPTION_BASE_URL', 'http://127.0.0.1:8000/v1');
  }
  for (const c of template.spec.containers) {
    if (!validCpu(Number(c.resources?.limits?.cpu ?? 1))) throw new Error(`Container ${c.name} asks for ${c.resources.limits.cpu} vCPU; Cloud Run allows 0.08-1, 2, 4, 6 or 8.`);
  }
  const cpu = template.spec.containers.reduce((sum, c) => sum + Number(c.resources?.limits?.cpu ?? 0), 0);
  if (cpu > MAX_CPU) throw new Error(`Containers request ${cpu} vCPU; Cloud Run allows ${MAX_CPU} per instance.`);
  const sidecars = template.spec.containers.filter(c => c.name !== 'app').map(c => c.name);
  if (sidecars.length) template.metadata.annotations['run.googleapis.com/container-dependencies'] = JSON.stringify({ app: sidecars });
  svc.metadata.annotations['run.googleapis.com/maxScale'] = '2';
  svc.spec.traffic = [{ revisionName: serving, percent: 100 }, { revisionName: revision, tag: 'candidate' }];
  return { manifest: svc, serving };
}

export function restore(live) {
  const svc = strip(live);
  svc.metadata.annotations['run.googleapis.com/maxScale'] = '1';
  return { manifest: svc };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, ...rest] = process.argv.slice(2);
  const args = new Map();
  for (let i = 0; i < rest.length; i += 2) args.set(rest[i].replace(/^--/, ''), rest[i + 1]);
  const live = JSON.parse(readFileSync(args.get('in'), 'utf8'));
  const { manifest, serving } = mode === 'candidate'
    ? candidate(live, { revision: args.get('revision'), appImage: args.get('app-image'), commit: args.get('commit'),
      voiceImage: args.get('voice-image'), voiceModel: args.get('voice-model') })
    : mode === 'restore' ? restore(live) : (() => { throw new Error('Usage: prepare-release.mjs candidate|restore --in live.json --out next.json ...'); })();
  writeFileSync(args.get('out'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${args.get('out')}.${serving ? ` Traffic stays on ${serving}; the new revision is tagged "candidate".` : ''}`);
}
