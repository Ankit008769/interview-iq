import { test, expect } from '@playwright/test';

test('a candidate creates a skill passport that verifies on its public page, and sees plans while payments are off', async ({ page, browser }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Passport Holder');
  await page.getByLabel('Email address').fill(`passport-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/seed-evidence')).status()).toBe(200);

  // Plans are visible during the beta, with nothing to buy yet.
  await page.goto('/account');
  await page.getByRole('link', { name: 'Plan and billing' }).click();
  await expect(page.getByRole('heading', { name: 'Plan and billing' })).toBeVisible();
  await expect(page.getByText(/During the beta everything is free/)).toBeVisible();
  await expect(page.getByText('Payments are not switched on yet.', { exact: false })).toBeVisible();
  const plans = page.getByRole('region', { name: 'Plans' });
  await expect(plans.locator('.plan-card')).toHaveCount(3);
  await expect(plans.getByRole('button', { name: 'Not available yet' }).first()).toBeDisabled();
  await expect(page.getByTestId('referral-code')).toHaveText(/^[A-Z2-9]{8}$/);

  // A passport with only the interview record, without the name.
  await page.goto('/passport');
  await expect(page.getByText(/Practice record, not a hiring score/).first()).toBeVisible();
  await page.getByLabel('AI-scored mock interviews').check();
  await expect(page.locator('.passport-record')).toContainText('1 completed (Technical 1)');
  await page.getByRole('button', { name: 'Create passport' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Passport created' });
  await expect(notice).toBeVisible();
  const link = (await notice.textContent())!.match(/https?:\/\/\S+\/passport\/[A-Za-z0-9_-]{22}/)![0];
  const json = await page.request.get(`/api/passport/${link.split('/').pop()}/credential.json`);
  expect((await json.json()).proof.cryptosuite).toBe('eddsa-jcs-2022');

  // Anyone with the link, signed out, sees it verified.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(link);
  await expect(visitor.getByText(/Verified: signed by Interview IQ, unchanged and not revoked/)).toBeVisible();
  await expect(visitor.locator('.passport-record')).toContainText('AI-scored mock interviews');
  await expect(visitor.getByText('Holder:')).toHaveCount(0);

  // Revoking hides it at once.
  page.once('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Revoke passport' }).click();
  await expect(page.getByText(/^Revoked /)).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByText('This passport was revoked by its holder.')).toBeVisible();
});
