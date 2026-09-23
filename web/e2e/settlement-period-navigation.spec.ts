import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Authenticates the stable administrator against the disposable full-stack fixture. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

test('settlement periods expose their date range and open exact booking filters', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await login(page);
  await page.goto('/finance?tab=settlements');
  await expect(page.getByRole('heading', { name: 'Perioden & Abrechnungen' })).toBeVisible();

  const openedSince = page.getByText(/^Geöffnet seit \d{2}\.\d{2}\.\d{4}$/);
  const periodStart = (await openedSince.textContent())?.replace('Geöffnet seit ', '') ?? '';
  await page.getByRole('button', { name: 'Periode abschließen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Periode abschließen' });
  const today = await page.evaluate(() => new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date()));
  await expect(dialog.getByLabel('Bezeichnung')).toHaveValue(`${periodStart} – ${today}`);
  await dialog.getByLabel('Bezeichnung').fill('Editable period label');
  await expect(dialog.getByLabel('Bezeichnung')).toHaveValue('Editable period label');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  const range = page.getByLabel(/^Zeitraum vom \d{2}\.\d{2}\.\d{4} bis \d{2}\.\d{2}\.\d{4}$/).first();
  await expect(range).toBeVisible();
  await expect(range.locator('time')).toHaveCount(2);

  const bookingsLink = page.getByRole('link', { name: /^Buchungen für .+ aus .+ anzeigen$/ }).first();
  const href = await bookingsLink.getAttribute('href');
  expect(href).not.toBeNull();
  const linkUrl = new URL(href ?? '', 'http://127.0.0.1:5173');
  const serializedFilters = linkUrl.searchParams.get('tt.activities.filters');
  expect(serializedFilters).not.toBeNull();
  expect(JSON.parse(serializedFilters ?? '{}')).toEqual({
    kind: ['BOOKING'],
    occurredAt: {
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
    periodId: expect.any(String),
    targetMembershipId: expect.any(String),
  });
  await bookingsLink.click();
  await expect(page).toHaveURL(/\/activities\?/);

  const filters = page.getByRole('list', { name: 'Ergebnisse filtern' });
  await expect(filters).toBeVisible();
  await expect(filters).toContainText('Vorgang: Buchung');
  await expect(filters).toContainText('Periode:');
  await expect(filters).toContainText('Mitglied:');
  await expect(filters).toContainText('Zeitpunkt:');
  await expect(page.getByRole('button', { name: 'Filter (4)' })).toBeVisible();
  await testInfo.attach('settlement-period-navigation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(consoleErrors).toEqual([]);
});
