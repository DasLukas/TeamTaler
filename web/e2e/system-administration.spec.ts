import { expect, test, type Locator, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Logs into the disposable full-stack fixture and waits for the expected workspace. */
async function login(page: Page, email: string, destination: RegExp): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(destination);
}

/** Activates a control without relying on emulated-mobile pointer scrolling. */
async function activate(control: Locator, keyboard: boolean): Promise<void> {
  if (keyboard) {
    await control.focus();
    await control.press('Enter');
    return;
  }
  await control.click();
}

test('a group-less system administrator receives only the reduced global shell', async ({ page }, testInfo) => {
  await login(page, 'systemonly@example.test', /\/admin$/);
  await expect(page.getByRole('tab', { name: 'System' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);

  const navigation = testInfo.project.name === 'narrow-mobile'
    ? page.getByRole('navigation', { name: 'Mobile Hauptnavigation' })
    : page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(navigation.getByRole('link', { name: 'System' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Mein Konto' })).toBeVisible();
  const logout = testInfo.project.name === 'narrow-mobile'
    ? navigation.getByRole('button', { name: 'Abmelden' })
    : page.locator('aside').getByRole('button', { name: 'Abmelden' });
  await expect(logout).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Buchen' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Finanzen' })).toHaveCount(0);

  await page.goto('/book');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('tab', { name: 'System' })).toBeVisible();
});

test('system administration updates settings and completes the group lifecycle', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const keyboardActivation = testInfo.project.name === 'narrow-mobile';
  await login(page, 'admin@example.test', /\/book$/);
  await page.goto('/admin');
  await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Diese globale Rolle kann aus Sicherheitsgründen ausschließlich lokal über das CLI vergeben oder entzogen werden.')).toBeVisible();

  const instanceName = `TeamTaler E2E ${testInfo.project.name}`;
  const instanceNameInput = page.getByLabel('Instanzname');
  await instanceNameInput.fill(instanceName);
  const settingsSaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/v1/system/settings');
  const generalSettings = page.locator('section[aria-labelledby="system-general-title"]');
  await generalSettings.getByRole('button', { name: 'Speichern' }).click();
  expect((await settingsSaved).status()).toBe(200);
  await expect(page.getByLabel('Instanzname')).toHaveValue(instanceName);

  const groupName = `Lifecycle ${testInfo.project.name}`;
  await page.getByLabel('Gruppenname').fill(groupName);
  await page.getByLabel('E-Mail des ersten Gruppenadministrators').fill('marie@example.test');
  const groupCreated = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/system/groups');
  await activate(page.getByRole('button', { name: 'Gruppe erstellen' }), keyboardActivation);
  expect((await groupCreated).status()).toBe(201);

  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: groupName, exact: true }) });
  await expect(card).toContainText('Aktiv');
  await expect(card).toContainText('marie@example.test');

  page.once('dialog', async (dialog) => dialog.accept());
  const archived = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/system\/groups\/[^/]+\/archive$/.test(new URL(response.url()).pathname));
  await activate(card.getByRole('button', { name: 'Archivieren' }), keyboardActivation);
  expect((await archived).status()).toBe(200);
  await expect(card).toContainText('Archiviert');

  const restored = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/system\/groups\/[^/]+\/restore$/.test(new URL(response.url()).pathname));
  await activate(card.getByRole('button', { name: 'Reaktivieren' }), keyboardActivation);
  expect((await restored).status()).toBe(200);
  await expect(card).toContainText('Aktiv');

  page.once('dialog', async (dialog) => dialog.accept());
  const rearchived = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/system\/groups\/[^/]+\/archive$/.test(new URL(response.url()).pathname));
  await activate(card.getByRole('button', { name: 'Archivieren' }), keyboardActivation);
  expect((await rearchived).status()).toBe(200);
  await expect(card).toContainText('Archiviert');

  await activate(card.getByRole('button', { name: 'Endgültig löschen' }), keyboardActivation);
  const purgeDialog = page.getByRole('dialog', { name: 'Archivierte Gruppe endgültig löschen' });
  await expect(purgeDialog.getByText('Diese Aktion kann nicht rückgängig gemacht werden.')).toBeVisible();
  await purgeDialog.getByLabel('Aktuelles Passwort').fill(password);
  await purgeDialog.getByLabel('Exakten Gruppennamen eingeben').fill(groupName);
  await purgeDialog.getByLabel('Bestätigungsphrase eingeben').fill('ENDGÜLTIG LÖSCHEN');
  const purged = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/system\/groups\/[^/]+\/purge$/.test(new URL(response.url()).pathname));
  await activate(purgeDialog.getByRole('button', { name: 'Endgültig löschen' }), keyboardActivation);
  expect((await purged).status()).toBe(200);
  await expect(card).toHaveCount(0);
  const purgeAudit = page.locator('article').filter({ hasText: groupName });
  await expect(purgeAudit.getByText('system.group.purged')).toBeVisible();

  const settingsReset = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/system/settings/reset');
  await activate(generalSettings.getByRole('button', { name: 'Override zurücksetzen' }), keyboardActivation);
  expect((await settingsReset).status()).toBe(200);
  await expect(page.getByLabel('Instanzname')).toHaveValue('TeamTaler');
});
