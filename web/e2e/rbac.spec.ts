import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

async function openRoleManagement(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Rollen & Rechte' }).click();
  await expect(page.getByRole('button', { name: 'Rolle anlegen' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rollenzuweisungen', exact: true })).toHaveCount(0);
}

async function openRoleAssignment(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Mitglieder' }).click();
  await page.getByRole('button', { name: `Rollen für ${name} bearbeiten` }).click();
  await expect(page.getByRole('dialog', { name: `Rollen für ${name}` })).toBeVisible();
}

test('dynamic access is granted, revoked immediately, and administrator lockout is prevented', async ({ browser }, testInfo) => {
  const roleName = `E2E Zugriff ${testInfo.project.name}`;
  const adminContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const adminPage = await adminContext.newPage();
  await login(adminPage, 'admin@example.test');
  await openRoleManagement(adminPage);

  await adminPage.getByRole('button', { name: 'Rolle anlegen' }).click();
  await adminPage.getByLabel('Rollenname').fill(roleName);
  await adminPage.getByRole('switch', { name: 'Recht „Finanzverwaltung“ umschalten' }).click();
  await adminPage.getByRole('switch', { name: 'Recht „Katalogverwaltung“ umschalten' }).click();
  const roleCreated = adminPage.waitForResponse((response) => response.request().method() === 'POST' && /\/groups\/[^/]+\/roles$/.test(new URL(response.url()).pathname));
  await adminPage.getByRole('button', { name: 'Speichern' }).click();
  expect((await roleCreated).status()).toBe(201);
  await expect(adminPage.getByRole('button', { name: new RegExp(roleName) })).toBeVisible();

  await openRoleAssignment(adminPage, 'Lena Player');
  const lenaAssignments = adminPage.getByRole('dialog', { name: 'Rollen für Lena Player' });
  const roleCheckbox = lenaAssignments.getByRole('checkbox', { name: new RegExp(roleName) });
  await roleCheckbox.click();
  await expect(roleCheckbox).toBeChecked();
  const roleAssigned = adminPage.waitForResponse((response) => response.request().method() === 'PUT' && /\/members\/[^/]+\/roles$/.test(new URL(response.url()).pathname));
  await lenaAssignments.getByRole('button', { name: 'Übernehmen' }).click();
  expect((await roleAssigned).status()).toBe(200);
  await expect(lenaAssignments).toHaveCount(0);

  const lenaContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const lenaPage = await lenaContext.newPage();
  await login(lenaPage, 'lena@example.test');
  if (testInfo.project.name === 'desktop') {
    await expect(lenaPage.getByRole('link', { name: 'Finanzen' })).toBeVisible();
    await expect(lenaPage.getByRole('link', { name: 'Katalog' })).toBeVisible();
  } else {
    await lenaPage.goto('/finance');
    await expect(lenaPage.getByRole('heading', { name: 'Finanzen' })).toBeVisible();
    await expect(lenaPage.getByRole('heading', { name: 'Kein Zugriff' })).toHaveCount(0);
    await lenaPage.goto('/catalog');
    await expect(lenaPage.getByRole('heading', { name: 'Katalog' })).toBeVisible();
    await expect(lenaPage.getByRole('heading', { name: 'Kein Zugriff' })).toHaveCount(0);
  }
  const groupID = await lenaPage.evaluate(async () => {
    const response = await fetch('/api/v1/session');
    const session = await response.json() as { activeGroupId: string };
    return session.activeGroupId;
  });

  await openRoleAssignment(adminPage, 'Lena Player');
  const refreshedLenaAssignments = adminPage.getByRole('dialog', { name: 'Rollen für Lena Player' });
  await refreshedLenaAssignments.getByRole('checkbox', { name: new RegExp(roleName) }).click();
  const roleRevoked = adminPage.waitForResponse((response) => response.request().method() === 'PUT' && /\/members\/[^/]+\/roles$/.test(new URL(response.url()).pathname));
  await refreshedLenaAssignments.getByRole('button', { name: 'Übernehmen' }).click();
  expect((await roleRevoked).status()).toBe(200);

  const deniedStatus = await lenaPage.evaluate(async (currentGroupID) => (await fetch(`/api/v1/groups/${currentGroupID}/accounts`)).status, groupID);
  expect(deniedStatus).toBe(403);
  await lenaPage.goto('/finance');
  await expect(lenaPage.getByRole('heading', { name: 'Kein Zugriff' })).toBeVisible();
  if (testInfo.project.name === 'desktop') await expect(lenaPage.getByRole('link', { name: 'Finanzen' })).toHaveCount(0);

  await openRoleAssignment(adminPage, 'Ada Admin');
  const adminAssignments = adminPage.getByRole('dialog', { name: 'Rollen für Ada Admin' });
  const administratorRole = adminAssignments.getByRole('checkbox', { name: /Group administrator|Gruppenadministrator/ });
  await expect(administratorRole).toBeChecked();
  await expect(administratorRole).toBeDisabled();

  await lenaContext.close();
  await adminContext.close();
});
