import { test, expect } from '@playwright/test';

const firstLine = 'Built a payments service in Node.js handling 2,000 requests per minute.';
const resume = `${firstLine}\nLed the move from REST polling to webhooks for order updates.\nSkills: TypeScript, MongoDB, Redis.`;

test('a resume tailors AI questions with a visible source line, and deleting it removes those questions', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Resume Candidate');
  await page.getByLabel('Email address').fill(`resume-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect(consent.disclosure.documents).toMatch(/resume or job description/);
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);

    await page.getByRole('link', { name: 'Resume & JD' }).first().click();
    await expect(page.getByRole('heading', { name: 'Resume & job descriptions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Title').fill('Resume, October 2026');
    await page.getByLabel('Text', { exact: true }).fill(resume);
    await page.getByRole('button', { name: 'Save resume' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved your resume.');
    await page.getByRole('button', { name: 'View text' }).click();
    await expect(page.locator('.document-text')).toContainText('Skills: TypeScript');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.documents-page').screenshot({ path: test.info().outputPath('documents-mobile.png') });
    // Five navigation items must fit side by side on a phone.
    for (const item of await page.locator('.mobile-navitem').all()) {
      const box = (await item.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await item.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.locator('.mobile-nav').screenshot({ path: test.info().outputPath('mobile-nav.png') });
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto('/interview/new');
    await page.getByLabel('Use AI for this interview').check();
    await page.getByRole('combobox', { name: 'Resume', exact: true }).selectOption({ label: 'Resume, October 2026' });
    await expect(page.getByText(/full text of the chosen documents is sent/)).toBeVisible();
    await page.getByRole('button', { name: /Start interview/ }).click();
    await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
    await expect(page.locator('.question-card h2')).toHaveText('Tell me about the project behind this line, question 1.');
    await expect(page.getByText(`Based on your resume: “${firstLine}”`)).toBeVisible();
    await page.locator('.question-card').screenshot({ path: test.info().outputPath('tailored-question.png') });
    const interviewUrl = page.url();

    await page.goto('/documents');
    await page.getByRole('button', { name: 'Delete Resume, October 2026' }).click();
    await expect(page.getByText(/Interview questions generated from it are removed too/)).toBeVisible();
    await page.getByRole('button', { name: 'Delete document and its questions' }).click();
    await expect(page.getByRole('status')).toHaveText('Deleted “Resume, October 2026” and the questions generated from it.');
    await expect(page.getByText(/No documents yet/)).toBeVisible();

    await page.goto(interviewUrl);
    await expect(page.locator('.question-card h2')).toHaveText('This question was removed because you deleted the document it was based on.');
    await expect(page.locator('.question-source')).toHaveCount(0);
    await expect(page.getByText(firstLine)).toHaveCount(0);
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
