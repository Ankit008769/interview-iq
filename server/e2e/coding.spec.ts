import { test, expect, type Page } from '@playwright/test';

const SOLUTION = 'function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    if (seen.has(target - nums[i])) return [seen.get(target - nums[i]), i];\n    seen.set(nums[i], i);\n  }\n}\n';

async function register(page: Page, name: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email address').fill(`${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
}
async function writeCode(page: Page, code: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await editor.fill(code);
}

test('the coding lab runs code against tests, then the interviewer asks and reviews', async ({ page }) => {
  await register(page, 'Coding Candidate');
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect(consent.disclosure.coding).toMatch(/no network access/);
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);

    await page.getByRole('link', { name: 'Coding' }).first().click();
    await expect(page).toHaveURL(/\/coding$/);
    await expect(page.getByRole('heading', { name: 'Coding lab', level: 1 })).toBeVisible();
    await page.getByRole('group', { name: 'Problem type' }).getByRole('button', { name: 'SQL' }).click();
    await expect(page.locator('.problem-card')).toHaveCount(5);
    await page.getByRole('group', { name: 'Problem type' }).getByRole('button', { name: 'All' }).click();
    await page.locator('.problem-card', { hasText: 'Two Sum' }).click();
    await expect(page).toHaveURL(/\/coding\/two-sum$/);
    await expect(page.getByRole('heading', { name: 'Two Sum', level: 1 })).toBeVisible();
    await expect(page.getByText('nums = [2,7,11,15], target = 9')).toBeVisible();

    const language = page.getByLabel('Language');
    await expect(language.locator('option', { hasText: 'Java 17 (unavailable)' })).toHaveAttribute('disabled', '');
    await language.selectOption('javascript');
    await expect(page.locator('.cm-content')).toContainText('function twoSum(nums, target)');

    // A wrong answer shows the expected and actual values for the examples.
    await writeCode(page, 'function twoSum(nums, target) {\n  return [0, 0];\n}\n');
    await page.getByRole('button', { name: 'Run examples' }).click();
    await expect(page.locator('.verdict-banner')).toContainText('Wrong answer');
    await expect(page.locator('.test-row.wrong_answer').first()).toContainText('Expected [0,1] Yours [0,0]');

    await writeCode(page, SOLUTION);
    await page.getByRole('button', { name: 'Run examples' }).click();
    await expect(page.locator('.verdict-banner')).toContainText('Examples passed');
    await expect(page.locator('.verdict-banner')).toContainText('Examples: 3/3 passed');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('.verdict-banner')).toContainText('Accepted');
    await expect(page.locator('.hidden-summary')).toContainText(/Hidden tests: (\d+)\/\1 passed\./);

    const followUp = page.getByRole('region', { name: 'Interviewer follow-up' });
    await followUp.getByRole('button', { name: "Get the interviewer's question" }).click();
    await expect(followUp.getByText('What are its time and space complexity')).toBeVisible();
    await followUp.getByLabel('Your answer').fill('One pass with a hash map: O(n) time and O(n) space for the map.');
    await followUp.getByRole('button', { name: 'Get feedback' }).click();
    const approach = followUp.locator('.review-criteria li', { hasText: 'Algorithmic approach' });
    await expect(approach.getByText('5/5')).toBeVisible();
    await expect(approach.getByText('“new Map()”')).toBeVisible();
    await expect(followUp.locator('.review-criteria li', { hasText: 'Explanation' }).getByText('Not enough evidence')).toBeVisible();
    await expect(followUp.getByText('Whether the code is correct comes only from the test results above.')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('coding-problem.png'), fullPage: true });

    // The draft survives a reload, and the run history lists the two example runs and the submission.
    await page.reload();
    await expect(page.locator('.cm-content')).toContainText('const seen = new Map();');
    await page.locator('.recent-runs summary').click();
    await expect(page.locator('.recent-runs li')).toHaveCount(3);

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: test.info().outputPath('coding-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/coding');
    await expect(page.locator('.problem-card', { hasText: 'Two Sum' }).getByText('Solved')).toBeVisible();
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
