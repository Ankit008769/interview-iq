import { test, expect } from '@playwright/test';

// Chromium's fake capture device supplies a real audio stream, so MediaRecorder runs for real.
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['microphone'] });

test('a spoken answer is transcribed into the answer box for review, and questions can be read aloud', async ({ page }) => {
  // Record what would be spoken instead of relying on voices in a headless browser.
  await page.addInitScript(() => {
    const spoken: string[] = [];
    Object.defineProperty(window, '__spoken', { value: spoken });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true,
      value: { speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text); }, cancel: () => {} } });
  });
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Voice Candidate');
  await page.getByLabel('Email address').fill(`voice-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  expect((await page.request.post('/__test/enable-gateway')).status()).toBe(204);
  try {
    const consent = await (await page.request.get('/api/account/ai-consent')).json();
    expect(consent.disclosure.voice).toMatch(/does not store the recording/);
    expect((await page.request.post('/api/account/ai-consent', { data: { version: consent.disclosure.version, accepted: true } })).status()).toBe(200);
    const created = await page.request.post('/api/interviews', { data: { mode: 'ai', role: 'Developer', type: 'Technical',
      difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2 } });
    const { interview } = await created.json();
    await page.goto(`/interview/${interview._id}`);

    await expect(page.locator('.question-card h2')).toHaveText('Explain indexed access, question 1.');
    await page.getByRole('button', { name: 'Read question aloud' }).click();
    expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(['Explain indexed access, question 1.']);

    await page.getByRole('textbox').fill('Indexing is fast.');
    await page.getByRole('button', { name: 'Answer by voice' }).click();
    const stop = page.getByRole('button', { name: /Stop recording/ });
    await expect(stop).toBeVisible();
    await expect(stop.getByRole('timer')).toHaveText(/0:0[1-9]/, { timeout: 5_000 });
    await page.locator('.answer-card').screenshot({ path: test.info().outputPath('recording.png') });
    await stop.click();
    await expect(page.getByRole('textbox')).toHaveValue('Indexing is fast. Arrays give constant-time indexed access.', { timeout: 15_000 });
    await expect(page.getByText(/sent for transcription, then discarded/)).toBeVisible();
    await page.locator('.interview-main').screenshot({ path: test.info().outputPath('transcribed.png') });
    await page.getByRole('textbox').fill('Arrays give constant-time indexed access because elements are contiguous.');
    await page.getByRole('button', { name: 'Submit & continue' }).click();
    await expect(page.locator('.question-card h2')).toHaveText('Explain indexed access, question 2.', { timeout: 10_000 });
    const saved = await (await page.request.get(`/api/interviews/${interview._id}`)).json();
    expect(saved.interview.turns[0].answer).toBe('Arrays give constant-time indexed access because elements are contiguous.');
  } finally {
    await page.request.post('/__test/disable-ai');
  }
});

async function openVoiceInterview(page: import('@playwright/test').Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Voice Recovery');
  await page.getByLabel('Email address').fill(`voice-recovery-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', {name:'Create account', exact:true}).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.request.post('/__test/enable-gateway');
  const {disclosure}=await (await page.request.get('/api/account/ai-consent')).json();
  await page.request.post('/api/account/ai-consent',{data:{version:disclosure.version,accepted:true}});
  const {interview}=await (await page.request.post('/api/interviews',{data:{mode:'ai',role:'Developer',type:'Technical',difficulty:'Intermediate',topic:'DSA',totalQuestions:2}})).json();
  await page.goto(`/interview/${interview._id}`);
  return interview._id;
}
async function record(page: import('@playwright/test').Page) {
  await page.getByRole('button',{name:'Answer by voice',exact:true}).click();
  const stop=page.getByRole('button',{name:/Stop recording/});
  await expect(stop.getByRole('timer')).toHaveText(/0:0[1-9]/);
  await stop.click();
}
test('cancelling transcription ignores a delayed result and typing stays safe',async({page})=>{
  await openVoiceInterview(page);
  try {
    let release!:()=>void;
    const delayed=new Promise<void>(resolve=>{release=resolve;});
    await page.route('**/transcribe',async route=>{await delayed;await route.fulfill({json:{transcript:'A late answer that must not be inserted.'}}).catch(()=>{});});
    const answer=page.locator('.answer-card > textarea');
    await answer.fill('My existing typed answer.');
    await record(page);
    await expect(page.getByRole('button',{name:'Submit & continue'})).toBeDisabled();
    await page.getByRole('button',{name:'Cancel voice answer'}).click();release();
    await expect(page.getByRole('button',{name:'Submit & continue'})).toBeEnabled();
    await expect(answer).toHaveValue('My existing typed answer.');
    await page.getByRole('button',{name:'Submit & continue'}).click();
    await expect(page.locator('.question-card h2')).toHaveText('Explain indexed access, question 2.');
    await expect(page.locator('.answer-card > textarea')).toHaveValue('');
  } finally {await page.request.post('/__test/disable-ai');}
});
test('an oversized transcript is kept for correction without truncating the typed answer',async({page})=>{
  await openVoiceInterview(page);
  try {
    const transcript='Spoken detail. '.repeat(300);
    await page.route('**/transcribe',route=>route.fulfill({json:{transcript}}));
    await page.locator('.answer-card > textarea').fill('Typed answer stays.');
    await record(page);
    await expect(page.getByLabel('Transcript to shorten')).toHaveValue(transcript);
    await expect(page.locator('.answer-card > textarea')).toHaveValue('Typed answer stays.');
    await page.getByLabel('Transcript to shorten').fill('Reviewed spoken detail.');
    await page.getByRole('button',{name:'Insert edited transcript'}).click();
    await expect(page.locator('.answer-card > textarea')).toHaveValue('Typed answer stays. Reviewed spoken detail.');
  } finally {await page.request.post('/__test/disable-ai');}
});
test('leaving a recording stops the microphone without uploading',async({page})=>{
  await page.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);(window as any).__voiceTracks=stream.getTracks();return stream;};
  });
  await openVoiceInterview(page);let uploads=0;
  page.on('request',request=>{if(request.url().endsWith('/transcribe'))uploads++;});
  try {
    await page.getByRole('button',{name:'Answer by voice',exact:true}).click();
    await expect(page.getByRole('button',{name:/Stop recording/})).toBeVisible();
    await page.locator('.interview-head').getByRole('link',{name:'Dashboard'}).click();
    await expect(page).toHaveURL(/dashboard/);
    await expect.poll(()=>page.evaluate(()=>(window as any).__voiceTracks.every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
    expect(uploads).toBe(0);
  } finally {await page.request.post('/__test/disable-ai');}
});
