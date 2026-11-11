import { test, expect, type Page } from '@playwright/test';

async function register(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
}

test('a placement office sets an assignment and a student joins its cohort and opens it', async ({ browser }) => {
  const stamp = Date.now();
  const staff = await (await browser.newContext()).newPage();
  const student = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  for (const page of [staff, student]) page.on('pageerror', e => problems.push(e.message));
  for (const page of [staff, student]) page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });

  // The officer creates the organisation and a cohort.
  await register(staff, 'Tara Officer', `tpo-${stamp}@example.test`);
  await staff.getByRole('link', { name: 'Campus' }).first().click();
  await staff.getByLabel('Organisation name').fill('Govt Engineering College');
  await staff.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(staff).toHaveURL(/\/org\/[a-f0-9]{24}$/);
  await expect(staff.getByRole('heading', { name: 'Govt Engineering College' })).toBeVisible();
  await expect(staff.getByTestId('join-code')).toHaveText(/^[A-Z2-9]{8}$/);
  await staff.getByLabel('New cohort').fill('CSE 2027');
  await staff.getByRole('button', { name: 'Add', exact: true }).click();
  const cohortRow = staff.locator('.campus-list li').filter({ hasText: 'CSE 2027' });
  await expect(cohortRow).toContainText('0 students');
  await cohortRow.getByRole('link', { name: /Open/ }).click();
  await expect(staff.getByRole('heading', { name: 'CSE 2027' })).toBeVisible();
  const code = (await staff.getByTestId('cohort-join-code').textContent())!.trim();

  // An interview assignment, due in a week by default.
  const form = staff.locator('.assignment-form');
  await form.getByLabel('Kind').selectOption('interview');
  await form.getByLabel('Topic').selectOption('React');
  await form.getByLabel('Level').selectOption('Advanced');
  await form.getByLabel('Questions').selectOption('5');
  await form.getByLabel('Style').selectOption('product');
  await expect(form.getByLabel('Title')).toHaveAttribute('placeholder', 'React interview');
  await form.getByRole('button', { name: 'Add assignment' }).click();
  await expect(staff.getByText('Assignment added.')).toBeVisible();
  await expect(staff.locator('.campus-list li').filter({ hasText: 'React interview' })).toContainText('0/0 done');

  // The student must agree to the sharing terms before joining.
  await register(student, 'Asha Verma', `asha-${stamp}@example.test`);
  await student.goto('/campus');
  await student.getByLabel('Join code').fill(code.toLowerCase());
  await student.getByLabel('Roll number (optional)').fill('21CS001');
  const join = student.getByRole('button', { name: 'Join', exact: true });
  await expect(join).toBeDisabled();
  await expect(student.getByText(/never see your answers, recordings, code, documents or projects/).first()).toBeVisible();
  await student.getByLabel('I agree to share this with the organisation').first().check();
  await join.click();
  await expect(student.getByText('You joined the organisation.')).toBeVisible();
  const assignment = student.locator('.assignment-list li').filter({ hasText: 'React interview' });
  await expect(assignment).toContainText('Due in 7 days');
  await expect(assignment).toContainText('Govt Engineering College');
  await expect(student.locator('.campus-list li.org-row').filter({ hasText: 'Govt Engineering College' })).toContainText('Student');
  await assignment.getByRole('link', { name: /Start/ }).click();
  await expect(student).toHaveURL(/\/interview\/new\?type=Technical&topic=React&difficulty=Advanced&questions=5&style=product$/);
  await expect(student.getByRole('button', { name: '5 questions' })).toHaveClass(/active/);
  await expect(student.getByRole('button', { name: 'Advanced', exact: true })).toHaveClass(/active/);
  await expect(student.getByLabel('Primary topic')).toHaveValue('React');

  // The officer sees the student in the cohort, and the export is offered.
  await staff.reload();
  const row = staff.locator('.cohort-table tbody tr').filter({ hasText: 'Asha Verma' });
  await expect(row).toContainText('21CS001');
  await expect(row).toContainText(`asha-${stamp}@example.test`);
  await expect(staff.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', /\/api\/orgs\/[a-f0-9]{24}\/cohorts\/[a-f0-9]{24}\/export\.csv$/);
  const csv = await staff.request.get((await staff.getByRole('link', { name: 'Export CSV' }).getAttribute('href'))!);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('Asha Verma');

  // Leaving stops sharing at once.
  await student.goto('/campus');
  student.once('dialog', d => void d.accept());
  await student.locator('.campus-list li.org-row').getByRole('button', { name: /Leave/ }).click();
  await expect(student.getByText('You left Govt Engineering College.')).toBeVisible();
  await staff.reload();
  await expect(staff.getByText('No students in this cohort yet.', { exact: false })).toBeVisible();
  expect(problems.filter(p => !/status of 401/.test(p))).toEqual([]);
});
