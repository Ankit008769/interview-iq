import { test, expect } from '@playwright/test';

test('a stronger version is built only from the answer and survives reload', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Rewrite Reader');
  await page.getByLabel('Email address').fill(`rewrite-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    const { id } = await (await page.request.post('/__test/seed-evidence')).json();
    await page.goto(`/interview/${id}/results`);

    await expect(page.getByRole('button', { name: 'Show a stronger version of this answer' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Show a stronger version of this answer' }).first().click();
    const version = page.getByRole('region', { name: 'Stronger version of this answer' });
    await expect(version).toHaveCount(1);
    await expect(version.getByText('Arrays give direct indexed access.')).toBeVisible();
    await expect(version.getByText('From your answer: “Arrays allow indexed access.”')).toBeVisible();
    await expect(version.getByText('Add only if true: [Add the time complexity of each operation]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show a stronger version of this answer' })).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('region', { name: 'Stronger version of this answer' })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('region', { name: 'Stronger version of this answer' }).screenshot({ path: test.info().outputPath('rewrite-mobile.png') });
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
