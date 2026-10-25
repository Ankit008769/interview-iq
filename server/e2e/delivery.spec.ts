import { test, expect } from '@playwright/test';

test('delivery feedback and STAR checks are shown apart from the score, and delivery can be turned off', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Delivery Candidate');
  await page.getByLabel('Email address').fill(`delivery-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    const { id } = await (await page.request.post('/__test/seed-behavioral')).json();
    await page.goto(`/interview/${id}/results`);

    const panel = page.getByRole('region', { name: 'Delivery feedback' });
    await expect(panel.getByText('Spoke for 1:05 in 3 recordings · 120 words per minute · fillers: “basically” ×2, “um” ×1, “you know” ×1')).toBeVisible();
    await expect(panel.getByText('Question 1')).toBeVisible();
    await expect(panel.locator('li').nth(1)).toHaveText('Question 2 0:20 · 120 words per minute · fillers: none counted');
    await expect(panel.getByText(/Not part of your score/)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Check STAR structure' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Check STAR structure' }).first().click();
    const star = page.getByRole('region', { name: 'STAR structure of this answer' });
    await expect(star.getByText('Found: “our demo server crashed a day before the review”')).toBeVisible();
    await expect(star.getByText('Not found. Add how the review went, if you know it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check STAR structure' })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await star.screenshot({ path: test.info().outputPath('star-mobile.png') });
    await panel.screenshot({ path: test.info().outputPath('delivery-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });

    await panel.getByRole('button', { name: 'Turn off delivery feedback' }).click();
    await expect(page.getByText('Delivery feedback is off. Turn it back on in Account.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Delivery feedback' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('region', { name: 'STAR structure of this answer' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Delivery feedback' })).toHaveCount(0);

    await page.goto('/account');
    const toggle = page.getByLabel('Measure and show delivery feedback for my voice answers');
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText('Delivery feedback is on.')).toBeVisible();
    await page.goto(`/interview/${id}/results`);
    await expect(page.getByRole('region', { name: 'Delivery feedback' })).toBeVisible();
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
