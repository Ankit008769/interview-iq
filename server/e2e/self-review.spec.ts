import { test, expect } from '@playwright/test';

// Chromium's fake camera shows a test pattern with no face, which is enough to prove the whole on-device path:
// MediaPipe's WebAssembly and model load under the app's content-security policy, frames are analysed,
// each answer is recorded into IndexedDB and plays back from a blob: URL on Results.
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['camera', 'microphone'] });

test('camera practice gives live tips, records each answer on the device and plays it back', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', e => problems.push(e.message));
  // MediaPipe's WebAssembly prints this informational line on stderr, which the browser reports as an error.
  page.on('console', m => { if (m.type() === 'error' && !/status of 401|Created TensorFlow Lite XNNPACK delegate/.test(m.text())) problems.push(m.text()); });
  const external: string[] = [];
  page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:5101/') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  const uploads: string[] = [];
  // Any request carrying media or a large body would be an upload of a recording.
  page.on('request', r => { if (r.method() !== 'GET' && (/video|audio|octet-stream|multipart/i.test(r.headers()['content-type'] ?? '') || (r.postDataBuffer()?.length ?? 0) > 20_000)) uploads.push(r.url()); });

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Camera Candidate');
  await page.getByLabel('Email address').fill(`camera-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto('/interview/new');
  await page.getByRole('button', { name: '2 questions', exact: true }).click();
  await page.getByRole('button', { name: 'Start interview', exact: true }).click();
  await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);

  const panel = page.getByRole('region', { name: 'Camera practice' });
  await expect(panel.getByText(/Nothing is uploaded, and expressions or emotions are never analysed/)).toBeVisible();
  await panel.getByRole('button', { name: 'Turn on camera' }).click();
  await expect(panel.getByTestId('framing-tip')).toHaveText('We cannot see your face. Sit facing the camera.', { timeout: 30_000 });
  await expect(panel.getByText('Recording on this device')).toBeVisible();
  // No face in view: the practice integrity alert shows (and beeps; sound alerts are on by default).
  await expect(panel.getByLabel('Sound alerts')).toBeChecked();
  await expect(panel.getByTestId('proctor-alert')).toHaveText('Your face left the frame.', { timeout: 15_000 });

  // The optional avatar follows the read-aloud speech events.
  await page.getByLabel('Interviewer avatar').check();
  const avatar = page.getByRole('img', { name: /Interviewer avatar/ });
  await expect(avatar).toHaveAttribute('data-speaking', 'false');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('iq-speech', { detail: 'start' })));
  await expect(avatar).toHaveAttribute('data-speaking', 'true');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('iq-speech', { detail: 'end' })));
  await expect(avatar).toHaveAttribute('data-speaking', 'false');

  await page.waitForTimeout(1500);
  await page.getByRole('textbox').fill('I use an array for indexed access and a linked list for pointer-based insertion.');
  await page.getByRole('button', { name: 'Submit & continue' }).click();
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('Recording on this device')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('textbox').fill('Two pointers moving at different speeds detect a cycle in linear time.');
  await page.getByRole('button', { name: 'Finish interview' }).click();
  await expect(page).toHaveURL(/results$/, { timeout: 15_000 });

  const review = page.getByRole('region', { name: 'Video self-review' });
  await expect(review.locator('.recording-list > li')).toHaveCount(2, { timeout: 10_000 });
  const first = review.locator('.recording-list > li').first();
  await expect(first).toContainText('Question 1');
  await expect(first).toContainText(/Face in view 0%/);
  await expect(first).toContainText(/out of view for much of the answer/);
  await expect(first.getByTestId('alert-summary')).toContainText('face out of view');
  await first.getByRole('button', { name: 'Watch' }).click();
  const video = first.locator('video');
  await expect(video).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThan(0);

  await review.getByRole('button', { name: 'Rate 4 out of 5' }).click();
  await expect(review.getByText(/Thanks for rating video self-review/)).toBeVisible();
  await first.getByRole('button', { name: 'Delete recording of question 1' }).click();
  await expect(review.locator('.recording-list > li')).toHaveCount(1);

  // The server learns only that the feature was used and rated.
  const exported = await (await page.request.get('/api/account/export')).json();
  expect(exported.featureEvents.map((e: { feature: string; kind: string; rating?: number }) => [e.feature, e.kind, e.rating ?? null]))
    .toEqual([['video_review', 'enabled', null], ['avatar', 'enabled', null], ['video_review', 'rating', 4]]);
  expect(JSON.stringify(exported)).not.toMatch(/framing|faceVisible|landmark/);
  expect(uploads).toEqual([]);

  // Account shows what this device holds and can delete it all.
  await page.goto('/account');
  await expect(page.getByText('1 recording on this device', { exact: false })).toBeVisible();
  page.once('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Delete all recordings on this device' }).click();
  await expect(page.getByText('No recordings on this device.')).toBeVisible();
  expect(problems).toEqual([]);
  // MediaPipe's usage logging is off: nothing was requested from any other address.
  expect(external).toEqual([]);
});
