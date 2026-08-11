import { expect, test, type Page, type Route } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

async function mockCapabilities(page: Page, available: boolean): Promise<void> {
  await page.route('**/api/v1/auth/capabilities', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ passwordResetAvailable: available, emailChangeAvailable: available }),
  }));
}

async function fulfillEmpty(route: Route, status: number): Promise<void> {
  await route.fulfill({ status, body: '' });
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

test('password recovery captures fragment tokens and never sends real mail', async ({ page }) => {
  await mockCapabilities(page, true);
  let requestedEmail = '';
  let resetCommand: unknown;
  await page.route('**/api/v1/auth/password-reset/request', async (route) => {
    requestedEmail = (route.request().postDataJSON() as { email: string }).email;
    await fulfillEmpty(route, 202);
  });
  await page.route('**/api/v1/auth/password-reset/confirm', async (route) => {
    resetCommand = route.request().postDataJSON();
    await fulfillEmpty(route, 204);
  });

  await page.goto('/login');
  await page.getByRole('link', { name: 'Passwort vergessen?' }).click();
  await page.getByLabel('E-Mail-Adresse').fill('unknown@example.test');
  await page.getByRole('button', { name: 'Link senden' }).click();
  await expect(page.getByText('Wenn die Adresse zu einem Konto gehört, erhältst du einen Link.')).toBeVisible();
  expect(requestedEmail).toBe('unknown@example.test');

  await page.goto('/reset-password#token=e2e-reset-secret');
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel('Neues Passwort').fill('Changed-Test-2026!');
  await page.getByLabel('Passwort bestätigen').fill('Changed-Test-2026!');
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(resetCommand).toEqual({ token: 'e2e-reset-secret', newPassword: 'Changed-Test-2026!' });
});

test('SMTP-off hides only mail-dependent account actions', async ({ page }) => {
  await mockCapabilities(page, false);
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Passwort vergessen?' })).toHaveCount(0);
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);

  await page.goto('/account');
  const accountData = page.getByRole('heading', { name: 'Kontodaten' }).locator('..');
  await expect(accountData.getByText('Ada Admin').locator('..').getByRole('button', { name: 'Bearbeiten' })).toBeVisible();
  await expect(accountData.getByLabel('Passwort').locator('..').getByRole('button', { name: 'Bearbeiten' })).toBeVisible();
  await expect(accountData.getByText('admin@example.test').locator('..').getByRole('button', { name: 'Bearbeiten' })).toHaveCount(0);
});

test('account changes use responsive sheets and mocked security endpoints', async ({ page }) => {
  await mockCapabilities(page, true);
  let profileCommand: unknown;
  let emailCommand: unknown;
  let passwordCommand: unknown;
  await page.route('**/api/v1/me/profile', async (route) => {
    profileCommand = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'user-admin', displayName: 'Ada Changed', email: 'admin@example.test' }) });
  });
  await page.route('**/api/v1/me/email-change', async (route) => {
    emailCommand = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ verificationRequired: true }) });
  });
  await page.route('**/api/v1/me/password', async (route) => {
    passwordCommand = route.request().postDataJSON();
    await fulfillEmpty(route, 204);
  });
  await page.route('**/api/v1/auth/email-change/confirm', async (route) => fulfillEmpty(route, 204));

  await login(page);
  await page.goto('/account');
  const accountData = page.getByRole('heading', { name: 'Kontodaten' }).locator('..');

  await accountData.getByText('Ada Admin').locator('..').getByRole('button', { name: 'Bearbeiten' }).click();
  const nameDialog = page.getByRole('dialog', { name: 'Name ändern' });
  await expect(nameDialog).toBeVisible();
  if (page.viewportSize()?.width === 390) await expect(nameDialog).toHaveCSS('width', '390px');
  await nameDialog.getByLabel('Name').fill('Ada Changed');
  await nameDialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Dein Name wurde gespeichert.')).toBeVisible();
  expect(profileCommand).toEqual({ displayName: 'Ada Changed' });

  await accountData.getByText('admin@example.test').locator('..').getByRole('button', { name: 'Bearbeiten' }).click();
  const emailDialog = page.getByRole('dialog', { name: 'E-Mail-Adresse ändern' });
  await emailDialog.getByLabel('Neue E-Mail-Adresse').fill('new@example.test');
  await emailDialog.getByLabel('Aktuelles Passwort').fill(password);
  await emailDialog.getByRole('button', { name: 'Bestätigungslink senden' }).click();
  await expect(emailDialog.getByText('Bestätige die neue Adresse über den Link in der E-Mail.')).toBeVisible();
  expect(emailCommand).toEqual({ newEmail: 'new@example.test', currentPassword: password });
  await emailDialog.getByRole('button', { name: 'Fertig' }).click();

  await accountData.getByLabel('Passwort').locator('..').getByRole('button', { name: 'Bearbeiten' }).click();
  const passwordDialog = page.getByRole('dialog', { name: 'Passwort ändern' });
  await passwordDialog.getByLabel('Aktuelles Passwort').fill(password);
  await passwordDialog.getByLabel('Neues Passwort').fill('Changed-Test-2026!');
  await passwordDialog.getByLabel('Passwort bestätigen').fill('Changed-Test-2026!');
  await passwordDialog.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(passwordCommand).toEqual({ currentPassword: password, newPassword: 'Changed-Test-2026!' });
});

test('email confirmation removes the token and returns to login', async ({ page }) => {
  let confirmation: unknown;
  await page.route('**/api/v1/auth/email-change/confirm', async (route) => {
    confirmation = route.request().postDataJSON();
    await fulfillEmpty(route, 204);
  });

  await page.goto('/email-change/confirm#token=e2e-email-secret');
  await expect(page).toHaveURL(/\/login$/);
  expect(new URL(page.url()).hash).toBe('');
  expect(confirmation).toEqual({ token: 'e2e-email-secret' });
});
