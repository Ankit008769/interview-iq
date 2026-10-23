import { test, expect, type Page } from '@playwright/test';

async function account(page: Page) {
  await page.request.post('/api/auth/register', { data: {
    name: 'Phase Zero Tester', email: `phase-${Date.now()}@example.test`, password: 'browser-test-password',
  } });
}

test('account server errors preserve the protected route and recover without signing in again', async ({ page }) => {
  await account(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' }));
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'Account unavailable' })).toBeVisible();
  await expect(page).toHaveURL(/history$/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await page.unroute('**/api/auth/me');
  await page.getByRole('button', { name: 'Retry loading account' }).click();
  await expect(page.getByRole('heading', { name: 'Interview history' })).toBeVisible();
});

test('network failure is distinct from a confirmed signed-out session', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.abort());
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'Account unavailable' })).toBeVisible();
  await page.unroute('**/api/auth/me');
  await page.getByRole('button', { name: 'Retry loading account' }).click();
  await expect(page).toHaveURL(/login$/);
});

test('history loads all pages and keeps existing rows after a failed page request', async ({ page }) => {
  await account(page);
  await page.request.post('/__test/seed-history');
  await page.goto('/history');
  const rows = page.locator('.history-row');
  await expect(rows).toHaveCount(20);
  await page.route(/\/api\/interviews\?cursor=/, route => route.abort(), { times: 1 });
  await page.getByRole('button', { name: 'Load more interviews' }).click();
  await expect(page.getByRole('button', { name: 'Retry loading more' })).toBeVisible();
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'Retry loading more' }).click();
  await expect(rows).toHaveCount(40);
  await page.getByRole('button', { name: 'Load more interviews' }).click();
  await expect(rows).toHaveCount(45);
  await expect(page.getByRole('button', { name: 'Load more interviews' })).toHaveCount(0);
  const links = await rows.evaluateAll(elements => elements.map(e => e.getAttribute('href')));
  expect(new Set(links).size).toBe(45);
});

test('initial history failure offers retry instead of claiming the account has no sessions', async ({ page }) => {
  await account(page);
  await page.route('**/api/interviews', route => route.abort(), { times: 1 });
  await page.goto('/history');
  await expect(page.getByRole('button', { name: 'Retry history' })).toBeVisible();
  await expect(page.getByText('No interviews yet', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry history' }).click();
  await expect(page.getByText('No interviews yet', { exact: true })).toBeVisible();
});

test('quota exhaustion explains the reset without starting another interview', async ({ page }) => {
  await account(page);
  await page.request.post('/__test/exhaust-starts');
  await page.goto('/interview/new');
  await page.getByRole('button', { name: 'Start interview', exact: true }).click();
  await expect(page.getByText(/daily interview starts limit has been reached/)).toBeVisible();
  await expect(page).toHaveURL(/interview\/new$/);
  const history = await page.request.get('/api/interviews');
  expect((await history.json()).interviews).toHaveLength(0);
});
