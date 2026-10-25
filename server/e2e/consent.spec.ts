import { test, expect } from '@playwright/test';
test('AI disclosure needs explicit permission, withdrawal blocks AI, and practice remains available',async({page})=>{
 await page.goto('/register');await page.getByLabel('Full name').fill('Consent Tester');await page.getByLabel('Email address').fill(`consent-${Date.now()}@example.test`);await page.getByLabel('Password',{exact:true}).fill('consent-browser-password');await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
 await page.request.post('/__test/enable-ai');
 try{
  await page.goto('/interview/new');await expect(page.getByText('OpenAI',{exact:true})).toBeVisible();
  const agreement=page.getByRole('checkbox',{name:'I agree to send my interview content to this provider for AI coaching.'});
  const useAI=page.getByRole('checkbox',{name:'Use AI for this interview (requires permission above)'});
  // AI is the default when the server offers it; starting waits for permission.
  await expect(agreement).not.toBeChecked();await expect(useAI).toBeChecked();await expect(page.getByRole('button',{name:'Allow AI processing'})).toBeDisabled();
  await expect(page.getByText(/^Needed for AI interviews: freshly written questions/)).toBeVisible();
  await expect(page.getByText(/^Accept AI processing above to start an AI interview/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Start interview',exact:true})).toBeDisabled();
  await agreement.check();await page.getByRole('button',{name:'Allow AI processing'}).click();await expect(page.getByText('Permission granted for this provider configuration.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Start interview',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Withdraw AI permission'}).click();await expect(agreement).not.toBeChecked();await expect(page.getByRole('button',{name:'Start interview',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('consent-mobile.png'),fullPage:true});
  await useAI.uncheck();await page.getByRole('button',{name:'Start interview',exact:true}).click();await expect(page.getByText('Guided practice · Technical')).toBeVisible();
 }finally{await page.request.post('/__test/disable-ai');}
});
