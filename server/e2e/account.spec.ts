import { test, expect } from '@playwright/test';
async function register(page:any) {
  const email=`lifecycle-${Date.now()}@example.test`;
  await page.goto('/register');await page.getByLabel('Full name').fill('Lifecycle Tester');
  await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('browser-test-password');
  await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
  return email;
}
test('account settings export, disabled email, password change, session revocation and deletion',async({page})=>{
  const email=await register(page);await page.goto('/account');
  await expect(page.getByRole('heading',{name:'Account & privacy'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Send verification email'})).toBeDisabled();
  await expect(page.getByText('No AI attempts recorded.')).toBeVisible();
  const exported=await page.request.get('/api/account/export');expect(exported.ok()).toBe(true);
  expect((await exported.json()).user.email).toBe(email);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('account-mobile.png'),fullPage:true});
  await page.getByLabel('Current password',{exact:true}).fill('browser-test-password');
  await page.getByLabel('New password',{exact:true}).fill('replacement-password');
  await page.getByRole('button',{name:'Change password and sign out'}).click();await expect(page).toHaveURL(/login/);
  await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('replacement-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
  await page.goto('/account');await page.getByRole('button',{name:'Revoke this session'}).click();await expect(page).toHaveURL(/login/);
  await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('replacement-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
  await page.goto('/account');await page.getByLabel('Password to delete account').fill('replacement-password');
  await page.getByLabel('Type DELETE').fill('DELETE');await page.getByRole('button',{name:'Permanently delete account'}).click();await expect(page).toHaveURL(/login/);
  const response=await page.request.post('/api/auth/login',{data:{email,password:'replacement-password'}});expect(response.status()).toBe(401);
});
test('recovery explains disabled delivery and invalid links without leaking the token in the URL',async({page})=>{
  await page.goto('/login');await page.getByRole('link',{name:'Forgot password?'}).click();
  await expect(page.getByRole('heading',{name:'Recover account'})).toBeVisible();
  await page.getByLabel('Email address').fill('unlisted@example.test');await page.getByRole('button',{name:'Request recovery link'}).click();
  await expect(page.getByRole('alert')).toContainText('not enabled');
  await page.goto('/account/verify#token='+'a'.repeat(64));await expect(page).toHaveURL(/\/account\/verify$/);
  await page.getByRole('button',{name:'Verify email',exact:true}).click();await expect(page.getByRole('alert')).toContainText('invalid or expired');
  await page.goto('/account/recovery#token='+'b'.repeat(64));await expect(page).toHaveURL(/\/account\/recovery$/);
  await page.getByLabel('New password').fill('replacement-password');await page.getByRole('button',{name:'Reset password',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('invalid or expired');
});

test('valid verification and recovery links complete the browser flows and cannot be reused',async({page})=>{
  const email=await register(page);
  const links=await (await page.request.post('/__test/account-links')).json();
  await page.goto('/account/verify#token='+links.verify);await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Email verified');
  await page.goto('/account');await expect(page.getByText(email+' · Verified',{exact:true})).toBeVisible();
  await page.request.post('/api/auth/logout');await page.goto('/account/recovery#token='+links.reset);
  await page.getByLabel('New password').fill('reset-browser-password');await page.getByRole('button',{name:'Reset password',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Password reset');
  await page.getByRole('link',{name:'Back to sign in'}).click();await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password',{exact:true}).fill('reset-browser-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
  await page.goto('/account/recovery#token='+links.reset);await page.getByLabel('New password').fill('another-password');
  await page.getByRole('button',{name:'Reset password',exact:true}).click();await expect(page.getByRole('alert')).toContainText('invalid or expired');
});


test('usage cost shows partial estimates and unknown attempts separately',async({page})=>{
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Usage Tester');
  await page.getByLabel('Email address').fill(`cost-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
  await page.route('**/api/account/usage',route=>route.fulfill({json:{rows:[{_id:'failed',attempts:2,inputTokens:20,outputTokens:5,unknownUsage:1,estimatedCostUsd:0.0028,unknownCost:1}],note:'Test fixture.'}}));
  await page.goto('/account');
  await expect(page.getByText(/Estimated provider cost/)).toContainText('0.002800');
  await expect(page.getByText(/Estimated provider cost/)).toContainText('Unknown-cost attempts: 1');
  await expect(page.getByText(/Estimated provider cost/)).toContainText('not an invoice');
});
