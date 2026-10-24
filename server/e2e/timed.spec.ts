import { test, expect } from '@playwright/test';

test('a timed round counts down, pauses with the question hidden, and reports time per answer', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Timed Candidate');
  await page.getByLabel('Email address').fill(`timed-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto('/interview/new');
  await page.getByRole('button', { name: '2 questions' }).click();
  await page.getByRole('button', { name: '2 min', exact: true }).click();
  await expect(page.getByText(/up to 4 minutes in total/)).toBeVisible();
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);

  const timer = page.getByRole('timer');
  await expect(timer).toContainText(/[12]:\d\d left/);
  const question = page.locator('.question-card h2');
  await expect(question).toBeVisible();
  await page.getByRole('textbox').fill('An array stores items contiguously, so indexed reads are constant time.');
  await page.getByRole('button', { name: 'Pause timer' }).click();
  await expect(page.getByRole('heading', { name: 'Round paused' })).toBeVisible();
  await page.locator('.interview-main').screenshot({ path: test.info().outputPath('paused.png') });
  await expect(question).toHaveCount(0);
  const frozen = await timer.textContent();
  await page.waitForTimeout(1500);
  await expect(timer).toHaveText(frozen!);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('An array stores items contiguously, so indexed reads are constant time.');
  await page.getByRole('button', { name: 'Submit & continue' }).click();

  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
  await expect(timer).toContainText(/left/);
  expect((await page.request.post('/__test/age-question?seconds=130')).status()).toBe(204);
  await page.reload();
  await expect(timer).toContainText(/Time is up · \+0:1\d/);
  await expect(page.getByText(/Time is up. Finish your thought and submit/)).toBeVisible();
  await page.locator('.interview-main').screenshot({ path: test.info().outputPath('time-up.png') });
  await page.getByRole('textbox').fill('A linked list follows pointers, so reaching the nth item takes linear time.');
  await page.getByRole('button', { name: 'Finish interview' }).click();

  await expect(page).toHaveURL(/results$/, { timeout: 10_000 });
  await expect(page.getByText('Timed round: 1 of 2 answers within the 2:00 limit.')).toBeVisible();
  await expect(page.getByText(/^Answered in 0:\d\d of 2:00/)).toBeVisible();
  await expect(page.getByText(/^Answered in 2:1\d, 0:1\d over the 2:00 limit$/)).toBeVisible();
  await page.locator('.review-turn').nth(1).screenshot({ path: test.info().outputPath('result-timing.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
