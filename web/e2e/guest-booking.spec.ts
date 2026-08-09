import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Authenticates a disposable acceptance-test account. */
async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

/** Ends the current browser session through the protected API. */
async function logout(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )teamtaler_csrf=([^;]*)/)?.[1] ?? '');
    return (await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } })).status;
  });
  expect(status).toBe(204);
}

/** Creates one temporary guest through an account that has only BOOK_FOR_GUESTS. */
async function createTemporaryGuestWithGuestOnlyPermission(page: Page, guestName: string): Promise<void> {
  const access = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json() as {
      activeGroupId: string;
      groups: Array<{ id: string; membership?: { effectiveGrants?: Array<{ permission: string }> } }>;
    };
    const group = session.groups.find((candidate) => candidate.id === session.activeGroupId);
    return {
      permissions: group?.membership?.effectiveGrants?.map((grant) => grant.permission).sort() ?? [],
      memberDirectoryStatus: (await fetch(`/api/v1/groups/${session.activeGroupId}/members`)).status,
    };
  });
  expect(access.permissions).toEqual(['BOOK_FOR_GUESTS']);
  expect(access.memberDirectoryStatus).toBe(403);

  await page.getByRole('button', { name: /Mineral Water/ }).click();
  await page.getByRole('button', { name: 'Buchung für' }).click();
  await page.getByLabel('Gast direkt hinzufügen').fill(guestName);
  await page.getByRole('button', { name: 'Gast zur Buchung hinzufügen' }).click();
  await expect(page.getByLabel('Begründung')).toHaveCount(0);

  const requestPromise = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/bookings/batch'));
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/bookings/batch'));
  await page.getByRole('button', { name: 'Jetzt buchen' }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toMatchObject({ targetMembershipIds: [], temporaryGuestDisplayNames: [guestName] });
  expect(request.postDataJSON()).not.toHaveProperty('reason');
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByText('Buchung gespeichert')).toBeVisible();
  await expect(page.getByText('Buchung gespeichert')).toHaveCount(0, { timeout: 3_000 });
}

/** Books for self and an existing temporary guest with a mixed permission set. */
async function reselectTemporaryGuestWithAdministrator(page: Page, guestName: string): Promise<void> {
  await page.getByRole('button', { name: /Mineral Water/ }).click();
  await page.getByRole('button', { name: 'Buchung für' }).click();
  const regularMembers = page.getByRole('group', { name: 'Mitglieder' });
  const guests = page.getByRole('group', { name: 'Gäste' });
  await expect(regularMembers).toBeVisible();
  await expect(guests).toBeVisible();
  await expect(regularMembers.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await guests.getByRole('checkbox', { name: guestName }).click();
  await expect(page.getByLabel('Begründung')).toHaveCount(0);
  await page.getByRole('button', { name: 'Buchung für' }).click();

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/bookings/batch'));
  await page.getByRole('button', { name: 'Für 2 Personen buchen' }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByText('Buchung gespeichert')).toBeVisible();
  await expect(page.getByText('Buchung gespeichert')).toHaveCount(0, { timeout: 3_000 });
}

/** Creates a claim invitation and returns its URL and exact role selection. */
async function createClaimInvitation(page: Page, guestName: string, email: string): Promise<{ acceptUrl: string; roleIds: string[] }> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Mitglieder' }).click();
  await page.getByRole('button', { name: `Login-Einladung für ${guestName} erstellen` }).click();
  const dialog = page.getByRole('dialog', { name: 'Gast zu eigenem Login einladen' });
  await dialog.getByLabel('E-Mail-Adresse').fill(email);

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/claim-invitation'));
  await dialog.getByRole('button', { name: 'Login-Einladung erstellen' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const body = await response.json() as { invitation: { roleIds: string[] }; acceptUrl: string };
  return { acceptUrl: body.acceptUrl, roleIds: body.invitation.roleIds };
}

test('temporary guest booking, mixed permissions, and account claim work end to end', async ({ page }, testInfo) => {
  const projectSuffix = testInfo.project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const guestName = `E2E Guest ${projectSuffix}`;
  const guestEmail = `e2e-guest-${projectSuffix}@example.test`;

  await login(page, 'lena@example.test');
  await createTemporaryGuestWithGuestOnlyPermission(page, guestName);
  await logout(page);

  await login(page, 'admin@example.test');
  await reselectTemporaryGuestWithAdministrator(page, guestName);
  const claim = await createClaimInvitation(page, guestName, guestEmail);
  expect(claim.roleIds).toHaveLength(1);

  await page.goto(claim.acceptUrl);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByLabel('Passwort bestätigen').fill(password);
  await page.getByRole('button', { name: 'Einladung annehmen' }).click();
  await expect(page).toHaveURL(/\/book$/);

  const claimed = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json() as {
      activeGroupId: string;
      groups: Array<{ id: string; membership?: { id: string; isTemporaryGuest: boolean; roleIds?: string[] } }>;
    };
    const membership = session.groups.find((candidate) => candidate.id === session.activeGroupId)?.membership;
    return {
      membership,
      directoryStatus: (await fetch(`/api/v1/groups/${session.activeGroupId}/members`)).status,
    };
  });
  expect(claimed.membership?.isTemporaryGuest).toBe(false);
  expect(claimed.membership?.roleIds).toEqual(claim.roleIds);
  expect(claimed.directoryStatus).toBe(200);

  await page.getByRole('button', { name: /Mineral Water/ }).click();
  const ownTarget = page.getByLabel('Buchung für');
  await expect(ownTarget).toBeDisabled();
  await expect(ownTarget).toContainText(guestName);
});
