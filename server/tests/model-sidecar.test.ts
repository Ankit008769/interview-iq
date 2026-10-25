import { expect, it } from 'vitest';
// @ts-expect-error The deploy helper is a plain ES module without type declarations.
import { addModelSidecar } from '../../deploy/add-model-sidecar.mjs';

const live = () => ({
  apiVersion: 'serving.knative.dev/v1', kind: 'Service',
  metadata: { name: 'interview-iq', uid: 'u', resourceVersion: 'r', generation: 9, creationTimestamp: 't',
    annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/minScale': '1', 'serving.knative.dev/creator': 'someone', 'run.googleapis.com/operation-id': 'op',
      'run.googleapis.com/build-id': 'old-build', 'run.googleapis.com/build-image-uri': 'app:old' } },
  spec: {
    template: { metadata: { name: 'interview-iq-cost-voice-c9bcf44', annotations: { 'run.googleapis.com/cpu-throttling': 'false' } },
      spec: { serviceAccountName: 'app@x.iam.gserviceaccount.com', timeoutSeconds: 60, containers: [{ image: 'app:old', ports: [{ containerPort: 8080 }],
        env: [{ name: 'AI_PROVIDER', value: 'practice' }, { name: 'CLIENT_ORIGIN', value: 'https://x' }, { name: 'DEPLOYMENT_COMMIT', value: 'c9bcf44' },
          { name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'interviewiq-jwt-secret', key: 'latest' } } }] }] } },
    traffic: [{ latestRevision: true, percent: 100 }],
  },
  status: { latestReadyRevisionName: 'interview-iq-cost-voice-c9bcf44', traffic: [{ revisionName: 'interview-iq-cost-voice-c9bcf44', percent: 100 }] },
});

it('adds the model sidecar, switches to local models and keeps everything else', () => {
  const { manifest, serving } = addModelSidecar(live(), { revision: 'interview-iq-local-models-abc1234', modelImage: 'ollama:img', appImage: 'app:new', commit: 'abc1234' });
  expect(serving).toBe('interview-iq-cost-voice-c9bcf44');
  expect(manifest.status).toBeUndefined();
  expect(manifest.metadata).toEqual({ name: 'interview-iq', annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/minScale': '1' } });
  const [app, model] = manifest.spec.template.spec.containers;
  expect(app).toMatchObject({ name: 'app', image: 'app:new', ports: [{ containerPort: 8080 }] });
  expect(manifest.spec.template.spec.timeoutSeconds).toBe(600);
  expect(app.env).toEqual([{ name: 'CLIENT_ORIGIN', value: 'https://x' }, { name: 'DEPLOYMENT_COMMIT', value: 'abc1234' },
    { name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'interviewiq-jwt-secret', key: 'latest' } } }, { name: 'AI_PROVIDER', value: 'local' }]);
  expect(model).toMatchObject({ name: 'ollama', image: 'ollama:img', resources: { limits: { cpu: '6', memory: '8Gi' } } });
  expect(model.ports).toBeUndefined();
  expect(manifest.spec.template.metadata).toEqual({ name: 'interview-iq-local-models-abc1234',
    annotations: { 'run.googleapis.com/cpu-throttling': 'false', 'run.googleapis.com/container-dependencies': '{"app":["ollama"]}' } });
  expect(manifest.spec.template.spec.serviceAccountName).toBe('app@x.iam.gserviceaccount.com');
  expect(manifest.spec.traffic).toEqual([{ revisionName: 'interview-iq-cost-voice-c9bcf44', percent: 100 }]);
});

it('refuses unclear or repeated changes', () => {
  expect(() => addModelSidecar(live(), { revision: 'other-local', modelImage: 'm' })).toThrow(/start with interview-iq-/);
  expect(() => addModelSidecar(live(), { revision: 'interview-iq-x' })).toThrow(/model-image/);
  const noStatus = { ...live(), status: undefined };
  expect(() => addModelSidecar(noStatus, { revision: 'interview-iq-x', modelImage: 'm' })).toThrow(/serving/);
  const once = addModelSidecar(live(), { revision: 'interview-iq-x', modelImage: 'm' }).manifest;
  expect(() => addModelSidecar({ ...once, status: live().status }, { revision: 'interview-iq-y', modelImage: 'm' })).toThrow(/already has a model sidecar/);
});
