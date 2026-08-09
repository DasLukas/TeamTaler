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

/**
 * Disables the guest feature through its authenticated API so every Playwright
 * project exercises the same visible activation flow against the shared server.
 */
async function resetGuestFeature(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const sessionResponse = await fetch('/api/v1/session');
    const session = await sessionResponse.json() as { activeGroupId: string };
    const [settingsResponse, rolesResponse] = await Promise.all([
      fetch(`/api/v1/groups/${session.activeGroupId}/settings`),
      fetch(`/api/v1/groups/${session.activeGroupId}/roles`),
    ]);
    const settings = await settingsResponse.json() as { guestsEnabled: boolean; guestRoleId: string | null; defaultRoleId: string | null };
    if (!settings.guestsEnabled) return 204;

    const roles = await rolesResponse.json() as Array<{ id: string; presetKey?: string }>;
    const replacementDefaultRoleId = settings.guestRoleId && settings.defaultRoleId === settings.guestRoleId
      ? roles.find((role) => role.presetKey === 'MEMBER' && role.id !== settings.guestRoleId)?.id
      : undefined;
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )teamtaler_csrf=([^;]*)/)?.[1] ?? '');
    const response = await fetch(`/api/v1/groups/${session.activeGroupId}/guest-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ guestsEnabled: false, ...(replacementDefaultRoleId ? { replacementDefaultRoleId } : {}) }),
    });
    return response.status;
  });
  expect(status).toBeLessThan(300);
}

/** Enables guests from the administrator settings and persists a safe guest role. */
async function enableGuestFeature(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Einstellungen' }).click();
  const toggle = page.getByRole('switch', { name: 'Gastfunktion aktivieren' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();

  const roleSelect = page.getByLabel('Rolle für Gäste');
  if (await roleSelect.inputValue() === '__no_guest_role__') {
    await roleSelect.selectOption({ label: 'Neue Rolle „Gast“ automatisch anlegen' });
  }

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/guest-settings'));
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(toggle).toBeChecked();
}

/** Creates one managed guest atomically with a product booking. */
async function createGuestWithBooking(page: Page, guestName: string): Promise<void> {
  await page.goto('/book');
  await page.getByRole('button', { name: /Mineral Water/ }).click();
  await page.getByRole('button', { name: 'Buchung für' }).click();
  await page.getByLabel('Gast direkt hinzufügen').fill(guestName);
  await page.getByRole('button', { name: 'Gast zur Buchung hinzufügen' }).click();
  await page.getByLabel('Begründung').fill('Disposable guest purchase');

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/bookings/batch'));
  await page.getByRole('button', { name: 'Jetzt buchen' }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByText('Buchung gespeichert')).toBeVisible();
  await expect(page.getByText('Buchung gespeichert')).toHaveCount(0, { timeout: 3_000 });
}

/** Re-selects the persisted guest for a later booking without creating a duplicate. */
async function reselectGuestForBooking(page: Page, guestName: string): Promise<void> {
  await page.getByRole('button', { name: /Mineral Water/ }).click();
  await page.getByRole('button', { name: 'Buchung für' }).click();
  const regularMembers = page.getByRole('group', { name: 'Mitglieder' });
  const guests = page.getByRole('group', { name: 'Gäste' });
  await expect(regularMembers).toBeVisible();
  await expect(guests).toBeVisible();
  await regularMembers.getByRole('checkbox', { checked: true }).click();
  await guests.getByRole('checkbox', { name: guestName }).click();
  await page.getByLabel('Begründung').fill('Returning guest purchase');

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/bookings/batch'));
  await page.getByRole('button', { name: 'Jetzt buchen' }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByText('Buchung gespeichert')).toBeVisible();
  await expect(page.getByText('Buchung gespeichert')).toHaveCount(0, { timeout: 3_000 });
}

/** Creates a claim invitation and returns its UI-provided fallback URL. */
async function createClaimInvitation(page: Page, guestName: string, email: string): Promise<string> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Mitglieder' }).click();
  await page.getByRole('button', { name: `Login-Einladung für ${guestName} erstellen` }).click();
  const dialog = page.getByRole('dialog', { name: 'Gast zu eigenem Login einladen' });
  await dialog.getByLabel('E-Mail-Adresse').fill(email);

  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/claim-invitation'));
  await dialog.getByRole('button', { name: 'Login-Einladung erstellen' }).click();
  expect((await responsePromise).status()).toBe(201);
  return dialog.getByLabel('Einladungslink (Rückfalloption)').inputValue();
}

test('guest activation, atomic inline booking, re-selection, and restricted login work end to end', async ({ page }, testInfo) => {
  const projectSuffix = testInfo.project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const guestName = `E2E Guest ${projectSuffix}`;
  const guestEmail = `e2e-guest-${projectSuffix}@example.test`;

  await login(page, 'admin@example.test');
  await resetGuestFeature(page);
  await enableGuestFeature(page);
  await createGuestWithBooking(page, guestName);
  await reselectGuestForBooking(page, guestName);
  const claimUrl = await createClaimInvitation(page, guestName, guestEmail);

  await page.goto(claimUrl);
  await expect(page.getByRole('button', { name: 'Einladung annehmen' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const protectedDirectoryRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/groups\/[^/]+\/members$/.test(pathname)) protectedDirectoryRequests.push(pathname);
  });
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByLabel('Passwort bestätigen').fill(password);
  await page.getByRole('button', { name: 'Einladung annehmen' }).click();
  await expect(page).toHaveURL(/\/book$/);
  await expect(page.getByRole('button', { name: /Mineral Water/ })).toBeVisible();

  const ownTarget = page.getByLabel('Buchung für');
  await page.getByRole('button', { name: /Mineral Water/ }).click();
  await expect(ownTarget).toBeDisabled();
  await expect(ownTarget).toContainText(guestName);
  expect(protectedDirectoryRequests).toEqual([]);

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
  expect(access.permissions).toEqual(['CREATE_OWN_BOOKING']);
  expect(access.memberDirectoryStatus).toBe(403);

  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Gruppenstatistik' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Finanzen' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Katalog' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Verwaltung' })).toHaveCount(0);
});
