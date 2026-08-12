import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Authenticates an acceptance-test account and waits for its landing route. */
async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/(?:book|overview|finance|admin)$/);
}

/** Ends the current browser session through the protected API. */
async function logout(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )teamtaler_csrf=([^;]*)/)?.[1] ?? '');
    return (await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } })).status;
  });
  expect(status).toBe(204);
}

/** Opens the lifecycle controls in the administration member directory. */
async function openMembers(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Mitglieder' }).click();
  await expect(page.getByRole('heading', { name: 'Aktive Mitglieder' })).toBeVisible();
}

test('regular members share archive, reactivate, and zero-balance permanent removal on desktop and mobile', async ({ page }, testInfo) => {
  const suffix = testInfo.project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const displayName = `Lifecycle ${suffix}`;
  const email = `lifecycle-${suffix}@example.test`;

  await login(page, 'admin@example.test');
  await openMembers(page);
  await page.getByRole('button', { name: 'Mitglied einladen' }).click();
  const invitationDialog = page.getByRole('dialog', { name: 'Mitglied einladen' });
  await invitationDialog.getByLabel('E-Mail-Adresse').fill(email);
  await invitationDialog.getByLabel('Anzeigename').fill(displayName);
  const invitationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/invitations'));
  await invitationDialog.getByRole('button', { name: 'Einladung erstellen' }).click();
  const invitationBody = await (await invitationResponse).json() as { acceptUrl: string };
  await logout(page);

  await page.goto(invitationBody.acceptUrl);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByLabel('Passwort bestätigen').fill(password);
  await page.getByRole('button', { name: 'Einladung annehmen' }).click();
  await expect(page).toHaveURL(/\/book$/);
  await page.getByRole('button', { name: /Mineral Water/ }).click();
  const bookingResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/bookings/batch'));
  await page.getByRole('button', { name: 'Jetzt buchen' }).click();
  expect((await bookingResponse).status()).toBe(201);
  const membership = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json() as {
      activeGroupId: string;
      groups: Array<{ id: string; membership?: { id: string } }>;
    };
    return {
      groupId: session.activeGroupId,
      membershipId: session.groups.find((group) => group.id === session.activeGroupId)?.membership?.id ?? '',
    };
  });
  expect(membership.membershipId).not.toBe('');
  await logout(page);

  await login(page, 'admin@example.test');
  await openMembers(page);
  await page.getByRole('button', { name: `${displayName} archivieren` }).click();
  let dialog = page.getByRole('dialog', { name: 'Mitglied archivieren' });
  await dialog.getByRole('button', { name: 'Archivieren', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Archivierte Mitglieder' })).toBeVisible();

  await page.getByRole('button', { name: 'Reaktivieren' }).click();
  dialog = page.getByRole('dialog', { name: 'Mitglied reaktivieren' });
  await dialog.getByRole('button', { name: 'Reaktivieren', exact: true }).click();
  await expect(page.getByRole('button', { name: `${displayName} archivieren` })).toBeVisible();

  await page.getByRole('button', { name: `${displayName} archivieren` }).click();
  dialog = page.getByRole('dialog', { name: 'Mitglied archivieren' });
  await dialog.getByRole('button', { name: 'Archivieren', exact: true }).click();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Mitglied löschen' });
  await dialog.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Das Konto muss vor dem Löschen vollständig ausgeglichen sein.');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  const settlementStatus = await page.evaluate(async ({ groupId, membershipId }) => {
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )teamtaler_csrf=([^;]*)/)?.[1] ?? '');
    const response = await fetch(`/api/v1/groups/${groupId}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `lifecycle-settlement-${membershipId}`,
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({ membershipId, amountMinor: 150, receivedAt: new Date().toISOString(), method: 'CASH', reference: 'Lifecycle test' }),
    });
    return response.status;
  }, membership);
  expect(settlementStatus).toBe(201);

  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Mitglied löschen' });
  const deletionResponse = page.waitForResponse((response) => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname.endsWith(`/members/${membership.membershipId}/permanent`));
  await dialog.getByRole('button', { name: 'Löschen', exact: true }).click();
  expect((await deletionResponse).status()).toBe(204);
  await expect(page.getByText(displayName, { exact: true })).toHaveCount(0);

  const retainedHistory = await page.evaluate(async ({ groupId, membershipId }) => {
    const [bookings, payments] = await Promise.all([
      fetch(`/api/v1/groups/${groupId}/bookings`).then((response) => response.json()) as Promise<Array<{ targetMembershipId: string; targetDisplayName: string; targetMembershipStatus: string }>>,
      fetch(`/api/v1/groups/${groupId}/payments`).then((response) => response.json()) as Promise<Array<{ membershipId: string; memberName: string; membershipStatus: string }>>,
    ]);
    return {
      booking: bookings.find((item) => item.targetMembershipId === membershipId),
      payment: payments.find((item) => item.membershipId === membershipId),
    };
  }, membership);
  expect(retainedHistory.booking).toMatchObject({ targetDisplayName: displayName, targetMembershipStatus: 'DELETED' });
  expect(retainedHistory.payment).toMatchObject({ memberName: displayName, membershipStatus: 'DELETED' });
});
