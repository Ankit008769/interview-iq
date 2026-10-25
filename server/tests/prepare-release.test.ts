import { expect, it } from 'vitest';
// @ts-expect-error The deploy helper is a plain ES module without type declarations.
import { candidate, restore } from '../../deploy/prepare-release.mjs';

const live = () => ({
  apiVersion: 'serving.knative.dev/v1', kind: 'Service',
  metadata: { name: 'interview-iq', uid: 'u', resourceVersion: 'r',
    annotations: { 'run.googleapis.com/maxScale': '1', 'run.googleapis.com/minScale': '1', 'run.googleapis.com/operation-id': 'op', 'run.googleapis.com/build-id': 'b' } },
  spec: {
    template: { metadata: { name: 'interview-iq-languages-2a4cc85', annotations: { 'run.googleapis.com/container-dependencies': '{"app":["ollama"]}' } },
      spec: { timeoutSeconds: 600, containers: [
        { name: 'app', image: 'app:2a4cc85', ports: [{ containerPort: 8080 }], resources: { limits: { cpu: '1', memory: '512Mi' } },
          env: [{ name: 'AI_PROVIDER', value: 'local' }, { name: 'DEPLOYMENT_COMMIT', value: 'old' }] },
        { name: 'ollama', image: 'ollama:v2', resources: { limits: { cpu: '6', memory: '8Gi' } } }] } },
    traffic: [{ revisionName: 'interview-iq-languages-2a4cc85', percent: 100 }],
  },
  status: { traffic: [{ revisionName: 'interview-iq-languages-2a4cc85', percent: 100 }] },
});

it('prepares an app release as an untrafficked candidate with room to start', () => {
  const { manifest, serving } = candidate(live(), { revision: 'interview-iq-next-abc1234', appImage: 'app:abc1234', commit: 'abc1234full' });
  expect(serving).toBe('interview-iq-languages-2a4cc85');
  expect(manifest.status).toBeUndefined();
  expect(manifest.metadata).toEqual({ name: 'interview-iq', annotations: { 'run.googleapis.com/maxScale': '2', 'run.googleapis.com/minScale': '1' } });
  const [app, ollama] = manifest.spec.template.spec.containers;
  expect(app.image).toBe('app:abc1234');
  expect(app.env).toEqual([{ name: 'AI_PROVIDER', value: 'local' }, { name: 'DEPLOYMENT_COMMIT', value: 'abc1234full' }]);
  expect(ollama.resources.limits.cpu).toBe('6');
  expect(manifest.spec.template.metadata.name).toBe('interview-iq-next-abc1234');
  expect(manifest.spec.traffic).toEqual([{ revisionName: 'interview-iq-languages-2a4cc85', percent: 100 }, { revisionName: 'interview-iq-next-abc1234', tag: 'candidate' }]);
});

it('adds the speech sidecar within the 8 vCPU limit and points the app at it', () => {
  const { manifest } = candidate(live(), { revision: 'interview-iq-voice-abc1234', voiceImage: 'whisper:small' });
  const containers = manifest.spec.template.spec.containers;
  expect(containers.map((c: any) => [c.name, c.resources.limits.cpu])).toEqual([['app', '1'], ['ollama', '6'], ['whisper', '1']]);
  expect(containers[2]).toMatchObject({ image: 'whisper:small', startupProbe: { httpGet: { path: '/health', port: 8000 } } });
  expect(containers[2].ports).toBeUndefined();
  expect(containers[0].env).toEqual(expect.arrayContaining([{ name: 'TRANSCRIPTION_MODEL', value: 'small' }, { name: 'TRANSCRIPTION_BASE_URL', value: 'http://127.0.0.1:8000/v1' }]));
  expect(manifest.spec.template.metadata.annotations['run.googleapis.com/container-dependencies']).toBe('{"app":["ollama","whisper"]}');
  // Re-running replaces the sidecar instead of adding a second one.
  const again = candidate({ ...manifest, status: live().status }, { revision: 'interview-iq-voice2-abc1234', voiceImage: 'whisper:base', voiceModel: 'base' }).manifest;
  expect(again.spec.template.spec.containers.filter((c: any) => c.name === 'whisper')).toHaveLength(1);
  expect(again.spec.template.spec.containers[0].env.filter((e: any) => e.name === 'TRANSCRIPTION_MODEL')).toEqual([{ name: 'TRANSCRIPTION_MODEL', value: 'base' }]);
});

it('restores the single-instance cap without a new revision and refuses unsafe input', () => {
  const { manifest } = restore({ ...live(), metadata: { ...live().metadata, annotations: { 'run.googleapis.com/maxScale': '2' } } });
  expect(manifest.metadata.annotations['run.googleapis.com/maxScale']).toBe('1');
  expect(manifest.spec.template.metadata.name).toBe('interview-iq-languages-2a4cc85');
  expect(() => candidate(live(), { revision: 'other-x' })).toThrow(/starting with interview-iq-/);
  expect(() => candidate(live(), { revision: 'interview-iq-languages-2a4cc85' })).toThrow(/already serving/);
  expect(() => candidate({ ...live(), status: undefined }, { revision: 'interview-iq-x' })).toThrow(/serving/);
  const big = live(); big.spec.template.spec.containers[1].resources.limits.cpu = '8';
  expect(() => candidate(big, { revision: 'interview-iq-x' })).toThrow(/Cloud Run allows 8 per instance/);
  const odd = live(); odd.spec.template.spec.containers[1].resources.limits.cpu = '5';
  expect(() => candidate(odd, { revision: 'interview-iq-x' })).toThrow(/ollama asks for 5 vCPU/);
});
