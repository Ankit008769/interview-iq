import { test, expect } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const zip = Buffer.from(zipSync({
  'chat/package.json': strToU8(JSON.stringify({ name: 'chat', dependencies: { express: '^4.19.0', 'socket.io': '^4.7.0' } })),
  'chat/.env': strToU8('DB_PASSWORD=never-shown-123\n'),
  'chat/src/chat.js': strToU8("const { Server } = require('socket.io');\nconst TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';\n\nfunction broadcastMessage(io, room, message) {\n  if (!message) throw new Error('empty');\n  const payload = { ...message, at: Date.now() };\n  io.to(room).emit('message', payload);\n  return payload;\n}\n\nmodule.exports = { broadcastMessage };\n"),
  'chat/src/server.js': strToU8("const express = require('express');\nconst app = express();\n\napp.post('/api/messages', (req, res) => {\n  const text = String(req.body.text || '').trim();\n  if (!text) return res.status(400).end();\n  res.status(201).json({ text });\n});\n\nmodule.exports = app;\n"),
}));

test('a project zip is indexed with secrets removed, claims are checked and the defense interview asks about real code', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Project Candidate');
  await page.getByLabel('Email address').fill(`project-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect(consent.disclosure.projects).toMatch(/never run/);
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    expect((await page.request.post('/api/documents', { data: { kind: 'resume', title: 'My resume', text: 'Final-year student.\nBuilt a real-time chat app with Socket.IO\nDeployed it on Kubernetes\nInterested in backend roles and distributed systems.' } })).status()).toBe(201);

    await page.getByRole('link', { name: 'Resume & code' }).first().click();
    const add = page.getByRole('region', { name: 'Add a code project' });
    await add.getByLabel('Project name').fill('Campus chat');
    await add.getByLabel('Zip file').setInputFiles({ name: 'chat.zip', mimeType: 'application/zip', buffer: zip });
    await add.getByRole('button', { name: 'Upload project' }).click();
    await expect(page).toHaveURL(/\/projects\/[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { name: 'Campus chat', level: 1 })).toBeVisible();
    const secrets = page.getByRole('region', { name: 'Secrets removed' });
    await expect(secrets).toContainText('2 secrets were removed before saving.');
    await expect(secrets).toContainText('.env: file not saved');
    await expect(secrets).toContainText('src/chat.js line 2: GitHub token removed');
    expect(await page.content()).not.toContain('never-shown-123');

    const index = page.getByRole('region', { name: 'Code index' });
    await index.getByLabel('Search functions, classes and routes').fill('broadcast');
    await index.getByRole('button', { name: /broadcastMessage/ }).click();
    await expect(index.locator('.symbol-code pre')).toContainText('io.to(room).emit');
    await expect(page.locator('body')).not.toContainText('ghp_a1B2');

    const claims = page.getByRole('region', { name: 'Resume claims' });
    await claims.getByRole('button', { name: 'Check claims against this code' }).click();
    await expect(claims.locator('.claim.supported')).toContainText('Built a real-time chat app with Socket.IO');
    await expect(claims.locator('.claim.supported')).toContainText('package.json');
    await expect(claims.locator('.claim.not_found')).toContainText('Deployed it on Kubernetes');
    await page.screenshot({ path: test.info().outputPath('project.png'), fullPage: true });

    const defense = page.getByRole('region', { name: 'Project defense interview' });
    await defense.getByRole('button', { name: 'Start project defense' }).click();
    await expect(page).toHaveURL(/\/interview\/[a-f0-9]{24}$/);
    await expect(page.locator('.question-card h2')).toContainText(/Why does (broadcastMessage|POST \/api\/messages) in src\/(chat|server)\.js work this way\?/);
    const source = page.locator('.code-source');
    await expect(source).toContainText('About your code:');
    await source.getByText('Show the code').click();
    await expect(source.locator('pre')).toContainText(/emit|res\.status/);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});
