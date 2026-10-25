import { test, expect } from '@playwright/test';

test('Learn shows skill estimates, plans for an interview and starts the chosen drill', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Learning Candidate');
  await page.getByLabel('Email address').fill(`learn-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    // One completed technical interview, every criterion rated 4 on both answers.
    expect((await page.request.post('/__test/seed-evidence')).status()).toBe(200);

    await page.goto('/dashboard');
    const today = page.getByRole('region', { name: "Today's practice" });
    await expect(today.getByRole('heading', { name: 'Behavioral stories' })).toBeVisible();
    await expect(today.getByText(/no behavioral practice yet/)).toBeVisible();
    await today.getByRole('link', { name: /Go to today's drill/ }).click();
    await expect(page).toHaveURL(/\/learn$/);

    const technical = page.getByRole('region', { name: 'Technical skills' });
    const correctness = technical.locator('.skill-row').filter({ hasText: 'Technical correctness' });
    await expect(correctness.getByText('Strong')).toBeVisible();
    await expect(correctness.getByRole('img', { name: /^Estimate 3\.5 of 5, likely between/ })).toBeVisible();
    await expect(correctness.getByText(/Low confidence/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Behavioral skills' }).getByText('Not practised yet').first()).toBeVisible();

    const form = page.getByRole('form', { name: 'Study plan' });
    await form.getByLabel('Interview date').fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    await form.getByLabel('Technical').uncheck();
    await form.getByLabel('HR').check();
    await form.getByRole('button', { name: '20 min' }).click();
    await form.getByRole('button', { name: 'Save plan' }).click();
    const plan = page.getByRole('region', { name: 'Study plan' });
    await expect(plan.getByRole('heading', { name: /days to your interview$/ })).toBeVisible();
    await expect(plan.getByText(/Focus: HR · 20 min a day \(3 questions per drill\)/)).toBeVisible();

    const drill = page.getByRole('region', { name: "Today's drill" });
    await expect(drill.getByText('First estimate', { exact: true })).toBeVisible();
    await expect(drill.getByRole('heading', { name: 'HR and career questions' })).toBeVisible();
    await expect(drill.getByText('HR · General · Intermediate · 3 questions · 5 min each')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('learn.png'), fullPage: true });

    // Phone width: everything fits without sideways scrolling.
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: test.info().outputPath('learn-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    await drill.getByRole('button', { name: "Start today's drill" }).click();
    await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
    await expect(page.locator('.interview-live')).toContainText('Practice drill');
    await expect(page.locator('.interview-live')).toContainText('HR');
    await expect(page.locator('.question-card h2')).toHaveText('Explain indexed access, question 1.');
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});

test('setup offers interview styles for AI interviews', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Style Candidate');
  await page.getByLabel('Email address').fill(`style-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    await page.goto('/interview/new');
    const styles = page.getByRole('group', { name: 'Interview style' });
    await expect(styles.getByRole('button', { name: 'General' })).toHaveAttribute('aria-pressed', 'true');
    await styles.getByRole('button', { name: 'Startup' }).click();
    await expect(page.getByText(/Practical ownership: shipping under constraints/)).toBeVisible();
    await page.getByRole('button', { name: /Start interview/ }).click();
    await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
    await expect(page.locator('.interview-live')).toContainText('Startup style');
    // Unticking AI hides the styles: practice questions come from the general bank.
    await page.goto('/interview/new');
    await page.getByLabel('Use AI for this interview').uncheck();
    await expect(page.getByRole('group', { name: 'Interview style' })).toHaveCount(0);
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
