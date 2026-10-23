import { test, expect, type Page } from '@playwright/test';

async function registerAndStart(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Browser Tester');
  await page.getByLabel('Email address').fill(`browser-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto('/interview/new');
  await page.getByRole('button', { name: '2 questions', exact: true }).click();
  await page.getByRole('button', { name: 'Start interview', exact: true }).click();
  await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
  await expect(page.getByRole('textbox')).toBeVisible();
}

test('saved answer survives reload; processing resumes and the full session completes', async ({ page, request }) => {
  await request.post('/__test/pause');
  await registerAndStart(page);
  const room = page.url();
  await page.getByRole('textbox').fill('I use an array for indexed access and a linked list for pointer-based insertion.');
  await page.getByRole('button', { name: 'Submit & continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your answer is saved' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your answer is saved' })).toBeVisible();
  await page.route('**/api/interviews/*', route => route.abort('failed'), { times: 1 });
  await expect(page.getByRole('alert')).toContainText('reconnecting', { timeout: 10_000 });
  await request.post('/__test/resume');
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('textbox').fill('Two pointers moving at different speeds detect a cycle in linear time.');
  await page.getByRole('button', { name: 'Finish interview' }).click();
  await expect(page).toHaveURL(/results$/, { timeout: 10_000 });
  await expect(page.getByText('Not scored', { exact: true })).toBeVisible();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await page.goto('/history');
  await expect(page.getByRole('link', { name: /Software Development Engineer/ })).toHaveCount(1);
  const response = await page.request.get(`/api/interviews/${room.split('/').pop()}`);
  expect((await response.json()).interview.turns).toHaveLength(2);
});

test('failed processing offers retry and returns to the next question without adding an answer', async ({ page, request }) => {
  await request.post('/__test/pause');
  await registerAndStart(page);
  const id = page.url().split('/').pop();
  await page.getByRole('textbox').fill('Arrays provide constant time indexed reads and contiguous storage.');
  await page.getByRole('button', { name: 'Submit & continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your answer is saved' })).toBeVisible();
  await request.post('/__test/fail');
  await expect(page.getByRole('button', { name: 'Retry processing' })).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await page.getByRole('button', { name: 'Retry processing' }).click();
  await expect(page.getByRole('button', { name: 'Retry processing' })).toHaveCount(0);
  await request.post('/__test/resume');
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
  const response = await page.request.get(`/api/interviews/${id}`);
  expect((await response.json()).interview.turns).toHaveLength(1);
});

test('a dropped acknowledgement can be retried without saving the answer twice', async ({ page, request }) => {
  await request.post('/__test/pause');
  await registerAndStart(page);
  const id = page.url().split('/').pop();
  await page.route('**/api/interviews/*/answer', async route => {
    await route.fetch(); // server commits, but the browser never receives the acknowledgement
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('textbox').fill('A linked list has nodes connected by pointers rather than contiguous elements.');
  await page.getByRole('button', { name: 'Submit & continue' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Submit & continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your answer is saved' })).toBeVisible();
  const response = await page.request.get(`/api/interviews/${id}`);
  expect((await response.json()).interview.turns).toHaveLength(1);
  await request.post('/__test/resume');
});

test('failed logout stays signed in and a successful retry clears the session', async ({ page }) => {
  await registerAndStart(page);
  await page.route('**/api/auth/logout', route => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign out failed');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/login$/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});
