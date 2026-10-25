import { test, expect } from '@playwright/test';

test('a Hindi AI interview is labelled and read aloud with a Hindi voice', async ({ page }) => {
  // Record what would be spoken, and in which language, instead of relying on voices in a headless browser.
  await page.addInitScript(() => {
    const spoken: { text: string; lang: string }[] = [];
    Object.defineProperty(window, '__spoken', { value: spoken });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true,
      value: { speak: (u: SpeechSynthesisUtterance) => { spoken.push({ text: u.text, lang: u.lang }); }, cancel: () => {}, getVoices: () => [] } });
  });
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Hindi Candidate');
  await page.getByLabel('Email address').fill(`hindi-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    // Right after sign-in, the dashboard shows what AI interviews offer and leads straight into one.
    await page.goto('/dashboard');
    const news = page.getByRole('region', { name: 'New in AI interviews' });
    await expect(news.getByText(/AI permission accepted/)).toBeVisible();
    await expect(news.getByText('Answer by voice', { exact: true })).toBeVisible();
    await expect(news.getByText('Hindi and Hinglish (beta)', { exact: true })).toBeVisible();
    await news.screenshot({ path: test.info().outputPath('whats-new.png') });
    await news.getByRole('link', { name: /Start an AI interview/ }).click();
    await expect(page).toHaveURL(/\/interview\/new$/);
    await expect(page.getByLabel('Use AI for this interview')).toBeChecked();
    const languages = page.getByRole('group', { name: 'Interview language' });
    await expect(languages.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await languages.getByRole('button', { name: 'हिन्दी (Hindi)' }).click();
    await expect(page.getByText(/^Beta: questions and feedback in Hindi \(Devanagari\)/)).toBeVisible();
    await page.locator('.language-box').screenshot({ path: test.info().outputPath('language-choice.png') });
    await page.getByRole('button', { name: /Start interview/ }).click();
    await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
    await expect(page.locator('.interview-live')).toContainText('हिन्दी (Hindi)');
    await expect(page.locator('.question-card h2')).toHaveText('Explain indexed access, question 1.');
    await page.getByRole('button', { name: 'Read question aloud' }).click();
    expect(await page.evaluate(() => (window as unknown as { __spoken: { text: string; lang: string }[] }).__spoken))
      .toEqual([{ text: 'Explain indexed access, question 1.', lang: 'hi-IN' }]);
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
