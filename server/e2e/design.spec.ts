import { test, expect } from '@playwright/test';

const box = (id: string, x: number, y: number, label: string) => [
  { id, type: 'rectangle', x, y, width: 180, height: 80, version: 1, boundElements: [{ id: `${id}-t`, type: 'text' }] },
  { id: `${id}-t`, type: 'text', x: x + 20, y: y + 30, width: 140, height: 25, version: 1, text: label, originalText: label, containerId: id, fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle' },
];
const arrow = (id: string, from: string, to: string, x: number, y: number, dx: number) =>
  ({ id, type: 'arrow', x, y, width: dx, height: 0, version: 1, points: [[0, 0], [dx, 0]], startBinding: { elementId: from, focus: 0, gap: 4 }, endBinding: { elementId: to, focus: 0, gap: 4 } });
const SCENE = [...box('app', 40, 60, 'Mobile app'), ...box('svc', 340, 60, 'Link service'), ...box('db', 640, 60, 'Postgres'),
  arrow('a1', 'app', 'svc', 220, 100, 120), arrow('a2', 'svc', 'db', 520, 100, 120)];

test('the design board saves a drawing, reads it as components and runs the follow-ups and review', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Design Candidate');
  await page.getByLabel('Email address').fill(`design-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    // Start with a drawing saved through the API, as if drawn earlier.
    const created = await (await page.request.post('/api/design/sessions', { data: { promptId: 'url-shortener' } })).json();
    expect((await page.request.put(`/api/design/sessions/${created.session.id}/draft`, { data: { scene: SCENE } })).status()).toBe(200);

    await page.getByRole('link', { name: 'Labs' }).first().click();
    await page.getByRole('navigation', { name: 'Practice labs' }).getByRole('link', { name: 'System design' }).click();
    await expect(page.getByRole('heading', { name: 'System design board', level: 1 })).toBeVisible();
    await expect(page.locator('.problem-card')).toHaveCount(30);
    await page.locator('.problem-card', { hasText: 'URL shortener' }).click();
    await expect(page.getByRole('region', { name: 'Scale' })).toContainText('20 million daily active users');
    await expect(page.locator('.excalidraw canvas').first()).toBeVisible();

    // Draw one more box with the rectangle tool and type its name inside it.
    const canvas = page.locator('.excalidraw canvas.interactive');
    await canvas.scrollIntoViewIfNeeded();
    const area = (await canvas.boundingBox())!;
    await page.mouse.click(area.x + 30, area.y + area.height - 30); // focus the board on an empty spot
    await page.keyboard.press('r');
    await page.mouse.move(area.x + area.width / 2 - 90, area.y + area.height - 130);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2 + 90, area.y + area.height - 50, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Redis cache');
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });

    const estimates = page.getByRole('region', { name: 'Capacity estimates' });
    await estimates.getByLabel('Average links created per second').fill('120');
    await estimates.getByLabel('Peak redirects per second').fill('50000');
    await estimates.getByLabel('New storage per year').fill('2');
    await page.getByLabel('Key decisions and trade-offs').fill('Reads dominate, so hot links are cached. IDs come from a counter encoded in base62.');
    await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
    const saved = await (await page.request.get(`/api/design/sessions/${created.session.id}`)).json();
    expect(JSON.stringify(saved.session.scene)).toContain('Redis cache');
    expect(saved.session.estimates).toMatchObject({ writeQps: 120, peakReadQps: 50000, storagePerYear: { value: 2, unit: 'TB' } });

    await page.getByRole('button', { name: 'Submit design' }).click();
    const read = page.getByRole('region', { name: 'How your design was read' });
    await expect(read).toContainText('4 components');
    await expect(read).toContainText('Mobile app → Link service');
    await expect(read).toContainText('Not connected to anything: Redis cache.');
    await expect(read.locator('.estimate-results li.close')).toHaveCount(2);
    await expect(read.locator('.estimate-results li.order_of_magnitude')).toContainText('7.2× too high');

    const followUp = page.getByRole('region', { name: 'Interviewer follow-up' });
    await followUp.getByRole('button', { name: "Get the interviewer's first question" }).click();
    await expect(followUp.locator('.interviewer-question').first()).toContainText('Links must expire after 30 days unless renewed. How does `Mobile app` cope?');
    await followUp.getByLabel('Your answer').fill('Add an expiry column with an index, and give cached keys the same TTL.');
    await followUp.getByRole('button', { name: 'Save answer' }).click();
    await followUp.getByRole('group', { name: 'Relevance of question 1' }).getByRole('button', { name: '4 out of 5' }).click();
    await expect(followUp.getByRole('group', { name: 'Relevance of question 1' }).getByRole('button', { name: '4 out of 5' })).toHaveAttribute('aria-pressed', 'true');
    await followUp.getByRole('button', { name: 'Next question' }).click();
    await expect(followUp.locator('.interviewer-question').nth(1)).toContainText('50 times the normal traffic');
    await followUp.getByLabel('Your answer').fill('Serve that link from the CDN edge and rate-limit per client.');
    await followUp.getByRole('button', { name: 'Save answer' }).click();
    await followUp.getByRole('button', { name: 'Get the review' }).click();
    await expect(followUp.locator('.design-review')).toContainText('A sensible first design');
    await expect(followUp.locator('.review-criteria li', { hasText: 'Requirements and scope' })).toContainText('4/5');
    await expect(followUp.locator('.review-criteria li', { hasText: 'Reliability and failure handling' })).toContainText('Not enough evidence');
    await page.screenshot({ path: test.info().outputPath('design.png'), fullPage: true });
    expect(problems).toEqual([]);
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
