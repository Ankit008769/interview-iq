import { test, expect } from '@playwright/test';

test('a rating can be challenged and shows the second AI review outcome after reload', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Challenge Reader');
  await page.getByLabel('Email address').fill(`challenge-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    const { id } = await (await page.request.post('/__test/seed-evidence')).json();
    await page.goto(`/interview/${id}/results`);
    await expect(page.getByText(/second AI review of up to 3 ratings/)).toBeVisible();

    await page.getByRole('button', { name: 'Challenge Depth of understanding rating', exact: true }).first().click();
    const reason = page.getByLabel('What did the review miss in your answer?');
    await expect(page.getByRole('button', { name: 'Request second review' })).toBeDisabled();
    await reason.fill('My first sentence says arrays allow indexed access.');
    await expect(page.getByText(/score can go up, down or stay the same. This is not a human review/)).toBeVisible();
    await page.getByRole('button', { name: 'Request second review' }).click();

    const outcome = page.getByText('Second AI review changed this rating from insufficient evidence to 5 / 5.', { exact: true });
    await expect(outcome).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Revised after second AI review', { exact: true })).toHaveCount(1);
    await expect(page.getByText('1 rating was changed by a second AI review. The overall estimate includes this change.')).toBeVisible();
    await expect(page.getByText('Insufficient evidence', { exact: true })).toHaveCount(7);

    await page.reload();
    await expect(outcome).toBeVisible();
    // The challenged rating cannot be challenged again; other ratings still can (2 of 3 remain).
    await expect(page.getByRole('button', { name: 'Challenge Depth of understanding rating', exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.criterion-card', { hasText: 'Revised after second AI review' }).screenshot({ path: test.info().outputPath('challenge-mobile.png') });
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
